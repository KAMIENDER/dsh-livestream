using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace DshStardew;

internal sealed class LocalConfig
{
    public LocalConfig() { }
    public int Port { get; set; } = 24643;
    public string SharedSecretBase64 { get; set; } = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
}

internal sealed record Request(string Id, string RunId, string ClientId, string Tool, string? ExpectedSaveId, int TimeoutMs, JsonElement Args)
{
    [System.Text.Json.Serialization.JsonIgnore] public DateTimeOffset Deadline { get; init; }
}
internal sealed record Pending(Request Request, TaskCompletionSource<object> Completion);

/// <summary>HTTP threads only parse/queue. All game reads and writes happen from UpdateTicking.</summary>
internal sealed class LocalServer : IDisposable
{
    internal const string Protocol = "dsh.stardew.extension.v1";
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, IncludeFields = true, MaxDepth = 32 };
    private readonly HttpListener listener = new();
    private readonly ConcurrentQueue<Pending> requests = new();
    private readonly LocalConfig config;
    private readonly GameFacts facts;
    private readonly MenuProjection menus;
    private readonly ControlLoop controls;
    private readonly NightObservation nights = new();
    private readonly Dictionary<string, (string hash, Task<object> task)> submitted = new();
    private readonly CancellationTokenSource lifetime = new();
    private string? owner;
    private string? ownerClient;
    private DateTimeOffset leaseExpires;
    private int queued;
    private bool? previousPauseWhenUnfocused;

    internal static readonly string[] ReadTools = { "dsh_get_identity", "dsh_query_progress", "dsh_query_social", "dsh_query_farm", "dsh_query_catalog", "dsh_query_mine", "dsh_query_event", "dsh_query_ui", "dsh_query_inventory", "dsh_query_machine", "dsh_query_fishing", "dsh_query_husbandry", "dsh_query_npc", "dsh_query_quests", "dsh_query_dialogue", "dsh_query_quest_ui", "dsh_query_orders", "dsh_query_food", "dsh_query_crafting", "dsh_query_storage", "dsh_query_shop", "dsh_query_shipping", "dsh_query_night", "dsh_query_slingshot", "dsh_query_construction" };
    internal static readonly string[] WriteTools = { "dsh_ui_action", "dsh_input", "dsh_fish", "dsh_combat", "dsh_animal", "dsh_split_stack", "dsh_machine", "dsh_fishing_gear", "dsh_husbandry", "dsh_npc_action", "dsh_dialogue", "dsh_quest_ui", "dsh_consume", "dsh_craft", "dsh_storage_ui", "dsh_shop_ui", "dsh_shipping", "dsh_mine_travel", "dsh_melee", "dsh_slingshot_ammo", "dsh_slingshot_shot", "dsh_construction", "dsh_construction_entry", "dsh_construction_move", "dsh_construction_paint", "dsh_construction_skin" };

    public LocalServer(LocalConfig config, IModHelper helper)
    {
        this.config = config;
        if (config.Port is < 1024 or > 65535 || Convert.FromBase64String(config.SharedSecretBase64).Length < 32) throw new ArgumentException("Invalid extension config");
        facts = new GameFacts(helper); menus = new MenuProjection(); controls = new ControlLoop(helper, menus);
        listener.Prefixes.Add($"http://127.0.0.1:{config.Port}/");
        listener.Start();
        _ = Listen();
    }

    private async Task Listen()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var context = await listener.GetContextAsync();
                _ = Handle(context);
            }
        }
        catch (Exception) when (lifetime.IsCancellationRequested) { }
    }

    private bool Authorized(HttpListenerRequest request)
    {
        var actual = Encoding.UTF8.GetBytes(request.Headers["Authorization"] ?? "");
        var expected = Encoding.UTF8.GetBytes($"Bearer {config.SharedSecretBase64}");
        return actual.Length == expected.Length && CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private async Task Handle(HttpListenerContext context)
    {
        try
        {
            if (!Authorized(context.Request)) { context.Response.StatusCode = 401; return; }
            if (context.Request.HttpMethod != "POST" || context.Request.Url?.AbsolutePath != "/v1") { context.Response.StatusCode = 404; return; }
            if (context.Request.ContentLength64 > 65536) { context.Response.StatusCode = 413; return; }
            using var buffer = new MemoryStream();
            var chunk = new byte[4096];
            while (true)
            {
                var count = await context.Request.InputStream.ReadAsync(chunk.AsMemory(), lifetime.Token);
                if (count == 0) break;
                if (buffer.Length + count > 65536) { context.Response.StatusCode = 413; return; }
                buffer.Write(chunk, 0, count);
            }
            var request = JsonSerializer.Deserialize<Request>(buffer.ToArray(), Json) ?? throw new ArgumentException("Missing request");
            if (!Guid.TryParse(request.Id, out _) || !Guid.TryParse(request.RunId, out _) || !Guid.TryParse(request.ClientId, out _) || request.Args.ValueKind != JsonValueKind.Object) throw new ArgumentException("Invalid request envelope");
            if (request.TimeoutMs is < 1000 or > 200000) throw new ArgumentException("Invalid request timeout");
            request = request with { Deadline = DateTimeOffset.UtcNow.AddMilliseconds(Math.Min(request.TimeoutMs - 500, 95000)) };
            if (Interlocked.Increment(ref queued) > 64) { Interlocked.Decrement(ref queued); context.Response.StatusCode = 429; return; }
            var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            requests.Enqueue(new Pending(request, completion));
            var result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(100), lifetime.Token);
            var payload = JsonSerializer.SerializeToUtf8Bytes(result, Json);
            context.Response.ContentType = "application/json; charset=utf-8";
            await context.Response.OutputStream.WriteAsync(payload.AsMemory(), lifetime.Token);
        }
        catch (Exception error)
        {
            // No body, shared secret, game text or full exception is copied to public responses/logs.
            context.Response.StatusCode = error is TimeoutException ? 504 : 400;
        }
        finally { context.Response.Close(); }
    }

    public void Tick()
    {
        // Overnight menus may exist while RequireWorld rejects RPCs. Observe locally,
        // without granting callers a bypass of the loaded-save/lease boundary.
        nights.ObserveMenu(Game1.activeClickableMenu);
        if (owner is not null && DateTimeOffset.UtcNow >= leaseExpires)
        {
            Release("lease_expired");
        }
        for (var count = 0; count < 16 && requests.TryDequeue(out var pending); count++)
        {
            Interlocked.Decrement(ref queued);
            try
            {
                var request = pending.Request;
                if (DateTimeOffset.UtcNow >= request.Deadline) throw new InvalidOperationException("request_expired_without_execution");
                if (WriteTools.Contains(request.Tool))
                {
                    var key = $"{request.RunId}:{request.Id}";
                    var hash = GameFacts.Hash(JsonSerializer.Serialize(request, Json));
                    RequireOwner(request);
                    if (submitted.TryGetValue(key, out var old))
                    {
                        if (old.hash != hash) throw new InvalidOperationException("request_id_conflict");
                        _ = FinishPending(pending, old.task);
                        continue;
                    }
                    if (submitted.Count >= 4096) throw new InvalidOperationException("run_request_limit");
                    Task<object> task;
                    try { task = Dispatch(request); }
                    catch (Exception error) { task = Task.FromException<object>(error); }
                    // Keep the same task even if the HTTP consumer times out. Duplicate IDs cannot repeat an action.
                    submitted[key] = (hash, task);
                    _ = FinishPending(pending, task);
                }
                else _ = FinishPending(pending, Dispatch(request));
            }
            catch (Exception error) { pending.Completion.TrySetResult(Failed(pending.Request, error.Message)); }
        }
        controls.Tick();
    }

    private async Task FinishPending(Pending pending, Task<object> operation)
    {
        try
        {
            var output = await operation;
            var uncertain = R.Text(output, "reason").StartsWith("controller_error:", StringComparison.Ordinal) || R.Bool(output, "completionUncertain");
            pending.Completion.TrySetResult(new { protocol = Protocol, requestId = pending.Request.Id, tool = pending.Request.Tool, status = uncertain ? "unknown" : "succeeded", output });
        }
        catch (Exception error) { pending.Completion.TrySetResult(Failed(pending.Request, error.Message,
            WriteTools.Contains(pending.Request.Tool) && error is not PreconditionRejectedException)); }
    }

    private static object Failed(Request request, string reason, bool unknown = false) => new {
        protocol = Protocol, requestId = request.Id, tool = request.Tool, status = unknown ? "unknown" : "failed",
        error = new { code = "extension_rejected", message = reason.Length <= 240 ? reason : "Extension operation failed" },
    };

    private static void RequireWorld()
    {
        if (!Context.IsWorldReady || !Context.IsMainPlayer || Context.IsMultiplayer) throw new InvalidOperationException("A loaded single-player host save is required");
    }

    private void RequireOwner(Request request, bool overnightHeartbeat = false)
    {
        if (!overnightHeartbeat || Context.IsWorldReady) RequireWorld();
        else if (!Context.IsMainPlayer || Context.IsMultiplayer) throw new InvalidOperationException("A single-player host is required");
        if (owner != request.RunId || ownerClient != request.ClientId) throw new InvalidOperationException("run_lease_required");
        if (request.ExpectedSaveId != GameFacts.SaveId()) { controls.Cancel("save_changed"); throw new InvalidOperationException("save_identity_changed"); }
        leaseExpires = DateTimeOffset.UtcNow.AddMinutes(2);
    }

    private Task<object> Dispatch(Request request)
    {
        object result;
        if (request.Tool == "dsh_capabilities") result = new { protocol = Protocol, version = "0.3.0", tools = ReadTools.Concat(WriteTools).ToArray(), nativeInputApi = "SMAPI 4.5.2 IInputHelper.Press", verifiedGameplay = false };
        else if (request.Tool == "dsh_end")
        {
            if (owner == request.RunId && ownerClient == request.ClientId) Release("client_stopped");
            result = new { released = true };
        }
        else if (request.Tool == "dsh_begin")
        {
            RequireWorld();
            if (owner is not null && (owner != request.RunId || ownerClient != request.ClientId)) throw new InvalidOperationException("Another client owns the extension; release it or wait for its lease to expire");
            if (controls.Busy) throw new InvalidOperationException("A prior controller is still running; inspect before resuming");
            result = GameFacts.Identity();
            owner = request.RunId; ownerClient = request.ClientId; leaseExpires = DateTimeOffset.UtcNow.AddMinutes(2);
            previousPauseWhenUnfocused ??= Game1.options.pauseWhenOutOfFocus;
            Game1.options.pauseWhenOutOfFocus = false;
        }
        else if (request.Tool == "dsh_heartbeat")
        {
            // Core sleep can last 180s. Renew only this already-owned, same real
            // save/client lease during overnight setup; no world read/write RPC
            // receives this exception, and ReturnedToTitle still clears ownership.
            RequireOwner(request, overnightHeartbeat: true);
            result = new { leaseRenewed = true };
        }
        else
        {
            RequireOwner(request);
            // Native menu operations and upstream actions must not overlap a realtime controller.
            if (WriteTools.Contains(request.Tool) && controls.Busy) throw new InvalidOperationException("Controller is busy");
            result = request.Tool switch {
                "dsh_get_identity" => GameFacts.Identity(),
                "dsh_query_progress" => facts.Progress(request.Args),
                "dsh_query_social" => facts.Social(request.Args),
                "dsh_query_farm" => facts.Farm(request.Args),
                "dsh_query_catalog" => facts.Catalog(request.Args),
                "dsh_query_mine" => facts.Mine(request.Args),
                "dsh_query_event" => facts.Event(),
                "dsh_query_ui" => menus.Capture(),
                "dsh_query_inventory" => InventoryActions.Capture(),
                "dsh_query_fishing" => FishingActions.Query(request.Args),
                "dsh_query_slingshot" => SlingshotActions.Query(request.Args),
                "dsh_query_husbandry" => HusbandryActions.Query(request.Args),
                "dsh_query_npc" => SocialActions.Query(request.Args),
                "dsh_query_quests" => SocialActions.Quests(request.Args),
                "dsh_query_dialogue" => SocialActions.Dialogue(),
                "dsh_query_quest_ui" => QuestActions.Capture(),
                "dsh_query_orders" => QuestActions.QueryOrders(request.Args),
                "dsh_query_food" => FoodActions.Query(request.Args),
                "dsh_query_crafting" => CraftingActions.Query(request.Args),
                "dsh_query_storage" => StorageActions.Query(request.Args),
                "dsh_query_shop" => ShopActions.Query(request.Args),
                "dsh_query_shipping" => ShippingActions.Query(request.Args),
                "dsh_query_night" => nights.Query(request.Args, request.RunId, request.ClientId),
                "dsh_query_construction" => ConstructionActions.Query(request.Args),
                "dsh_quest_ui" => R.Arg(request.Args, "operation") == "open_log" ? QuestActions.Open(request.Args)
                    : R.Arg(request.Args, "operation") == "close" ? QuestActions.Close(request.Args) : controls.Start(request.Tool, request.Args, request.Deadline),
                "dsh_npc_action" => SocialActions.Act(request.Args),
                "dsh_husbandry" => HusbandryActions.Act(request.Args),
                "dsh_fishing_gear" => FishingActions.Gear(request.Args),
                "dsh_slingshot_ammo" => SlingshotActions.Gear(request.Args),
                "dsh_query_machine" => MachineActions.Query(request.Args),
                "dsh_split_stack" => InventoryActions.Split(request.Args),
                "dsh_machine" => MachineActions.Act(request.Args),
                "dsh_ui_action" => R.Arg(request.Args, "operation", "click") is "click" or "right_click" ? controls.Start(request.Tool, request.Args, request.Deadline) : menus.Act(request.Args),
                "dsh_input" or "dsh_fish" or "dsh_combat" or "dsh_animal" or "dsh_dialogue" or "dsh_consume" or "dsh_craft" or "dsh_storage_ui" or "dsh_shop_ui" or "dsh_shipping" or "dsh_mine_travel" or "dsh_melee" or "dsh_slingshot_shot" or "dsh_construction" or "dsh_construction_entry" or "dsh_construction_move" or "dsh_construction_paint" or "dsh_construction_skin" => controls.Start(request.Tool, request.Args, request.Deadline),
                _ => throw new ArgumentException("Unknown extension tool"),
            };
        }
        return result is Task<object> task ? task : Task.FromResult(result);
    }

    public void Reset(string reason)
    {
        Release(reason);
        while (requests.TryDequeue(out var pending)) { Interlocked.Decrement(ref queued); pending.Completion.TrySetResult(Failed(pending.Request, reason)); }
    }

    private void Release(string reason)
    {
        controls.Cancel(reason); owner = null; ownerClient = null; submitted.Clear();
        nights.Clear();
        // Restore only the option value this lease changed, not the player's game state or save.
        if (previousPauseWhenUnfocused is { } previous && !Game1.options.pauseWhenOutOfFocus) Game1.options.pauseWhenOutOfFocus = previous;
        previousPauseWhenUnfocused = null;
    }

    public void DayEnding() => nights.DayEnding(owner, ownerClient);
    public void DayStarted() => nights.DayStarted();
    public void MenuChanged(StardewValley.Menus.IClickableMenu? menu) => nights.ObserveMenu(menu);

    public void Dispose()
    {
        Reset("extension_stopped"); lifetime.Cancel(); listener.Close(); lifetime.Dispose();
    }
}
