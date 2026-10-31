using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>Short controllers run on the game thread; remote model latency never drives individual fishing frames.</summary>
internal sealed partial class ControlLoop
{
    private readonly IModHelper helper;
    private readonly MenuProjection menus;
    private Job? job;
    public bool Busy => job is not null;

    private sealed class Job
    {
        public string Kind = "";
        public string Mode = "";
        public string Save = "";
        public string Day = "";
        public GameLocation Location = null!;
        public Tool? Tool;
        public DateTimeOffset Deadline;
        public int MaxTicks;
        public int Ticks;
        public int HealthFloor;
        public string Stage = "";
        public bool SawMinigame;
        public bool SawCaught;
        public bool LastPressed;
        public object Before = null!;
        public string[] Buttons = Array.Empty<string>();
        public object? Menu;
        public object? Minigame;
        public Point Pointer;
        public JsonElement Args;
        public bool AimPointer;
        public FarmAnimal? Animal;
        public object? AnimalBefore;
        public string? Produce;
        public int ProduceQuality;
        public int ProduceCount;
        public long ProduceBefore;
        public bool Submitted;
        public FishingAttempt? Fishing;
        public FoodActions.Attempt? Food;
        public CraftingActions.Attempt? Craft;
        public StorageActions.Attempt? Storage;
        public ShopActions.Attempt? Shop;
        public ShippingActions.Attempt? Shipping;
        public MineActions.Attempt? Mine;
        public TaskCompletionSource<object> Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public ControlLoop(IModHelper helper, MenuProjection menus) { this.helper = helper; this.menus = menus; }

    public Task<object> Start(string kind, JsonElement args, DateTimeOffset requestDeadline)
    {
        if (job is not null) throw new InvalidOperationException("Another realtime controller is running");
        var duration = kind == "dsh_mine_travel" ? R.Int(args, "durationMs", 30000, 3000, 45000)
            : kind == "dsh_shipping" ? (R.Arg(args, "operation") is "deposit" or "withdraw" ? 24000 : 3000)
            : kind == "dsh_shop_ui" ? (R.Arg(args, "operation") == "sell" ? 24000 : 3000)
            : kind == "dsh_consume" ? R.Int(args, "durationMs", 15000, 1000, 20000) : kind is "dsh_dialogue" or "dsh_quest_ui" or "dsh_craft" or "dsh_storage_ui" ? 3000 : kind == "dsh_ui_action" ? 1500 : kind == "dsh_fish" ? R.Int(args, "durationMs", 45000, 1000, 90000)
            : kind is "dsh_combat" or "dsh_animal" ? R.Int(args, "durationMs", kind == "dsh_animal" ? 6000 : 3000, 100, 10000)
            : R.Int(args, "durationMs", 100, 16, 2000);
        var created = new Job {
            Kind = kind, Mode = R.Arg(args, "mode", "attack"), Save = GameFacts.SaveId(), Day = GameFacts.DayKey(),
            Location = Game1.currentLocation, Tool = Game1.player.CurrentTool,
            Menu = Game1.activeClickableMenu, Minigame = R.Get(typeof(Game1), "currentMinigame"),
            Deadline = DateTimeOffset.UtcNow.AddMilliseconds(duration), MaxTicks = (int)Math.Ceiling(duration * 60d / 1000),
            HealthFloor = R.Int(args, "healthFloor", 30, 1, 1000), Before = GameFacts.ControlState(),
        };
        if (created.Deadline > requestDeadline) created.Deadline = requestDeadline;
        if (kind == "dsh_mine_travel") created.Mine = MineActions.Prepare(args);
        else if (kind == "dsh_shipping") created.Shipping = ShippingActions.Prepare(args);
        else if (kind == "dsh_shop_ui") created.Shop = ShopActions.Prepare(args);
        else if (kind == "dsh_storage_ui") created.Storage = StorageActions.Prepare(args);
        else if (kind == "dsh_craft")
        {
            created.Craft = CraftingActions.Prepare(args);
        }
        else if (kind == "dsh_ui_action")
        {
            created.Pointer = menus.PositionPointer(args);
            created.Args = args.Clone();
        }
        else if (kind == "dsh_input")
        {
            if (!menus.Matches(R.Arg(args, "revision"))) throw new InvalidOperationException("stale_ui: observe the input context again");
            var semantic = args.TryGetProperty("buttons", out var buttons) && buttons.ValueKind == JsonValueKind.Array ? buttons.EnumerateArray().Select(b => b.GetString() ?? "") : Enumerable.Empty<string>();
            var literal = args.TryGetProperty("keys", out var keys) && keys.ValueKind == JsonValueKind.Array ? keys.EnumerateArray().Select(b => "key:" + b.GetString()) : Enumerable.Empty<string>();
            created.Buttons = semantic.Concat(literal).Distinct().ToArray();
            if (created.Buttons.Length is < 1 or > 3) throw new ArgumentException("Use 1..3 semantic buttons");
            foreach (var button in created.Buttons) ResolveButton(button);
            if (R.Arg(args, "target").Length > 0) { created.Pointer = menus.PositionPointer(args); created.AimPointer = true; }
        }
        else if (kind == "dsh_dialogue")
        {
            created.Pointer = SocialActions.DialoguePointer(args);
            created.Args = args.Clone();
        }
        else if (kind == "dsh_quest_ui")
        {
            created.Pointer = QuestActions.Pointer(args);
            created.Args = args.Clone();
        }
        else
        {
            if (!Context.CanPlayerMove || Game1.eventUp || Game1.activeClickableMenu is not null) throw new InvalidOperationException("Player must be idle in the world");
            if (kind == "dsh_consume")
            {
                created.Food = FoodActions.Prepare(args); created.Submitted = true;
                if (!FoodActions.Begin(created.Food))
                {
                    created.Completion.TrySetResult(FoodActions.Finish(created.Food, true));
                    return created.Completion.Task;
                }
            }
            else if (kind == "dsh_fish")
            {
                PrepareFishing(created, args);
                var direction = R.Int(args, "direction", Game1.player.FacingDirection, 0, 3);
                created.Submitted = true;
                Game1.player.CurrentToolIndex = R.Int(args, "rodSlot", -1, 0, Game1.player.Items.Count - 1);
                if (!ReferenceEquals(Game1.player.CurrentTool, created.Tool)) throw new InvalidOperationException("Native selected rod was not confirmed");
                Game1.player.faceDirection(direction);
                var offset = direction switch { 0 => new Vector2(0, -1), 1 => new Vector2(1, 0), 2 => new Vector2(0, 1), _ => new Vector2(-1, 0) };
                Game1.player.toolPower.Value = 0;
                Game1.player.toolHold.Value = 0;
                Game1.player.lastClick = (Game1.player.Tile + offset) * 64 + new Vector2(32, 32);
                Game1.player.BeginUsingTool();
                created.Stage = "charging";
            }
            else if (kind == "dsh_combat")
            {
                if (!new[] { "attack", "special", "retreat" }.Contains(created.Mode)) throw new ArgumentException("Unknown combat mode");
                if (created.Mode != "retreat" && (created.Tool is not MeleeWeapon weapon || weapon.isScythe())) throw new InvalidOperationException("Equip a melee weapon; scythes are not combat support");
            }
            else if (kind == "dsh_animal")
            {
                created.Mode = R.Arg(args, "mode");
                if (!new[] { "pet", "milk", "shear" }.Contains(created.Mode)) throw new ArgumentException("Unknown animal care mode");
                created.Animal = AnimalCare.Find(R.Arg(args, "locationId"), R.Arg(args, "animalId"));
                created.AnimalBefore = AnimalCare.Project(created.Animal, created.Location);
                created.Args = args.Clone(); created.Stage = "prepared";
                if (!AnimalCare.InReach(created.Animal)) throw new InvalidOperationException("Navigate adjacent to the actual animal first");
            }
            else throw new ArgumentException("Unknown realtime controller");
        }
        job = created;
        return created.Completion.Task;
    }

    // SMAPI 4.5.2 Press lasts one input tick. Stopping means no further synthetic inputs;
    // never force-finish a fishing menu, edit its success meter, or suppress the user's own keys.
    public void Tick()
    {
        var current = job;
        if (current is null) return;
        try
        {
            // A mine transition intentionally changes location. Its controller
            // validates the exact native destination instead of following a stale floor.
            if (current.Kind == "dsh_mine_travel") { TickMineTravel(current); return; }
            if (!Context.IsWorldReady || !Context.IsMainPlayer || Context.IsMultiplayer) { Finish("world_unavailable"); return; }
            if (GameFacts.SaveId() != current.Save || GameFacts.DayKey() != current.Day || !ReferenceEquals(Game1.currentLocation, current.Location)) { Finish("context_changed"); return; }
            if (Game1.player.health <= 0 || ((current.Kind is "dsh_fish" or "dsh_combat" or "dsh_animal") && current.Mode != "retreat" && Game1.player.health < current.HealthFloor)) { Finish("health_limit"); return; }
            if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("time_limit"); return; }
            if (current.Kind == "dsh_consume") { TickFood(current); return; }
            if (current.Kind == "dsh_craft") { TickCrafting(current); return; }
            if (current.Kind == "dsh_storage_ui") { TickStorage(current); return; }
            if (current.Kind == "dsh_shop_ui") { TickShop(current); return; }
            if (current.Kind == "dsh_shipping") { TickShipping(current); return; }
            if (current.Kind is "dsh_dialogue" or "dsh_quest_ui")
            {
                object CaptureSemantic() => current.Kind == "dsh_dialogue" ? SocialActions.Dialogue() : QuestActions.Capture();
                if (!ReferenceEquals(current.Menu, Game1.activeClickableMenu))
                {
                    job = null; current.Completion.TrySetResult(new { submitted = false, stale = true, after = CaptureSemantic() }); return;
                }
                var dialogue = CaptureSemantic();
                if (R.Text(dialogue, "revision") != R.Arg(current.Args, "revision"))
                {
                    job = null; current.Completion.TrySetResult(new { submitted = false, stale = true, after = dialogue }); return;
                }
                if (current.Kind == "dsh_dialogue" && !R.Bool(dialogue, "ready")) return;
                var p = current.Pointer;
                if (Math.Abs(Game1.getMouseX(true) - p.X) > 2 || Math.Abs(Game1.getMouseY(true) - p.Y) > 2
                    || Math.Abs(Game1.getOldMouseX(true) - p.X) > 2 || Math.Abs(Game1.getOldMouseY(true) - p.Y) > 2) return;
                current.Submitted = true;
                var result = current.Kind == "dsh_dialogue" ? SocialActions.DialogueClick(current.Args, p) : QuestActions.Click(current.Args, p);
                job = null; current.Completion.TrySetResult(result); return;
            }
            if (current.Kind == "dsh_ui_action")
            {
                if (!ReferenceEquals(current.Menu, Game1.activeClickableMenu)) { Finish("ui_context_changed"); return; }
                var point = current.Pointer;
                if (Math.Abs(Game1.getMouseX(true) - point.X) > 2 || Math.Abs(Game1.getMouseY(true) - point.Y) > 2
                    || Math.Abs(Game1.getOldMouseX(true) - point.X) > 2 || Math.Abs(Game1.getOldMouseY(true) - point.Y) > 2) return;
                var result = menus.Act(current.Args);
                job = null;
                current.Completion.TrySetResult(new { reason = "ui_action_submitted", uiResult = result, before = current.Before, after = GameFacts.ControlState(), completedWorkflow = false });
                return;
            }
            if (current.Kind == "dsh_input")
            {
                if (!ReferenceEquals(current.Menu, Game1.activeClickableMenu) || !ReferenceEquals(current.Minigame, R.Get(typeof(Game1), "currentMinigame"))) { Finish("input_context_changed"); return; }
                if (current.AimPointer && (Math.Abs(Game1.getMouseX(true) - current.Pointer.X) > 2 || Math.Abs(Game1.getMouseY(true) - current.Pointer.Y) > 2
                    || Math.Abs(Game1.getOldMouseX(true) - current.Pointer.X) > 2 || Math.Abs(Game1.getOldMouseY(true) - current.Pointer.Y) > 2)) return;
                foreach (var button in current.Buttons) Press(button);
                return;
            }
            if (current.Kind == "dsh_animal") { TickAnimal(current); return; }
            if (!ReferenceEquals(Game1.player.CurrentTool, current.Tool)) { Finish("tool_changed"); return; }
            if (current.Kind == "dsh_fish") TickFishing(current);
            else TickCombat(current);
        }
        catch (Exception error) { Finish($"controller_error:{error.GetType().Name}"); }
    }

    private void TickAnimal(Job current)
    {
        var animal = current.Animal!;
        var player = Game1.player;
        if (!AnimalCare.In(current.Location).Any(value => ReferenceEquals(value, animal))) { Finish("animal_context_changed"); return; }
        if (Game1.activeClickableMenu is not null || Game1.eventUp) { Finish("needs_ui"); return; }
        if (!current.Submitted)
        {
            if (!Context.CanPlayerMove || player.UsingTool || !AnimalCare.InReach(animal)) { Finish("animal_not_reachable_now"); return; }
            if (current.Mode == "pet")
            {
                if (animal.wasPet.Value) { FinishAnimal(current, "already_petted"); return; }
                current.Submitted = true;
                // Exact public native interaction. Do not call pet again: a second pet may open its management UI.
                animal.pet(player, false);
            }
            else
            {
                var selected = AnimalCare.ToolFor(current.Mode);
                current.Produce = AnimalCare.ProduceId(animal);
                if (selected is null || current.Produce is null || !animal.isAdult() || !animal.CanGetProduceWithTool(selected.Value.tool)) { Finish("animal_or_tool_not_ready"); return; }
                if (R.Arg(current.Args, "expectedProduceItemId") != current.Produce) { Finish("animal_produce_changed"); return; }
                current.ProduceQuality = animal.produceQuality.Value;
                current.ProduceCount = AnimalCare.ProduceCount(animal);
                if (!player.couldInventoryAcceptThisItem(current.Produce, current.ProduceCount, current.ProduceQuality)) { Finish("inventory_full"); return; }
                if (player.Stamina < 30) { Finish("energy_limit"); return; }
                current.ProduceBefore = AnimalCare.InventoryCount(current.Produce, current.ProduceQuality);
                current.Tool = selected.Value.tool;
                // Equip exactly an owned native MilkPail/Shears; never create inventory or write animal produce fields.
                player.CurrentToolIndex = selected.Value.index;
                if (!ReferenceEquals(player.CurrentTool, current.Tool)) { Finish("tool_selection_not_confirmed"); return; }
                var delta = animal.Tile - player.Tile;
                player.faceDirection(Math.Abs(delta.X) > Math.Abs(delta.Y) ? delta.X > 0 ? 1 : 3 : delta.Y > 0 ? 2 : 0);
                player.toolPower.Value = 0; player.toolHold.Value = 0;
                var center = animal.GetHarvestBoundingBox().Center;
                player.lastClick = new Vector2(center.X, center.Y);
                var at = player.GetToolLocation(false);
                var reach = new Rectangle((int)at.X - 32, (int)at.Y - 32, 64, 64);
                // This is the exact selector used by MilkPail/Shears.beginUsing in the inspected CIL.
                // Check it BEFORE submitting so two overlapping animals cannot silently switch our target.
                if (!ReferenceEquals(Utility.GetBestHarvestableFarmAnimal(AnimalCare.In(current.Location), current.Tool, reach), animal)) { Finish("native_animal_target_mismatch"); return; }
                current.Submitted = true;
                player.BeginUsingTool();
            }
        }
        if (current.Mode != "pet" && !ReferenceEquals(player.CurrentTool, current.Tool)) { Finish("tool_changed"); return; }
        if (player.UsingTool || !player.CanMove) return;
        if (current.Mode == "pet")
        {
            if (animal.wasPet.Value) FinishAnimal(current, "animal_care_confirmed");
        }
        else
        {
            var gained = AnimalCare.InventoryCount(current.Produce!, current.ProduceQuality) - current.ProduceBefore;
            if (string.IsNullOrEmpty(animal.currentProduce.Value) && gained == current.ProduceCount) FinishAnimal(current, "animal_care_confirmed");
        }
    }

    private void FinishAnimal(Job current, string reason)
    {
        job = null;
        current.Completion.TrySetResult(new { reason, controller = current.Kind, mode = current.Mode,
            animalId = AnimalCare.Id(current.Animal!), beforeAnimal = current.AnimalBefore,
            afterAnimal = AnimalCare.Project(current.Animal!, current.Location),
            produceItemId = current.Produce, produceQuality = current.Mode == "pet" ? (int?)null : current.ProduceQuality,
            inventoryGain = current.Produce is null ? 0 : AnimalCare.InventoryCount(current.Produce, current.ProduceQuality) - current.ProduceBefore,
            nativeActionSubmitted = current.Submitted, completedWorkflow = true, before = current.Before, after = GameFacts.ControlState(),
            note = "Only this specific pet/milk/shear operation was verified; feeding, buying, moving and selling are separate workflows.",
        });
    }

    private void TickCombat(Job current)
    {
        if (Game1.activeClickableMenu is not null || Game1.eventUp) { Finish("needs_ui"); return; }
        var player = Game1.player;
        var monster = Game1.currentLocation.characters.OfType<Monster>().Where(m => m.Health > 0)
            .OrderBy(m => Vector2.DistanceSquared(m.Tile, player.Tile)).FirstOrDefault();
        if (monster is null) { Finish("no_visible_monsters"); return; }
        var delta = monster.Tile - player.Tile;
        var direction = Math.Abs(delta.X) > Math.Abs(delta.Y) ? (delta.X > 0 ? 1 : 3) : (delta.Y > 0 ? 2 : 0);
        if (current.Mode == "retreat")
        {
            Press(new[] { "move_down", "move_left", "move_up", "move_right" }[direction]);
            return;
        }
        if (Vector2.Distance(monster.Tile, player.Tile) > 2.5f) { Finish("target_out_of_range"); return; }
        if (player.UsingTool || !player.CanMove) return;
        player.faceDirection(direction);
        if (current.Mode == "special")
        {
            // beginSpecialMove/specialCooldown are not public in the inspected build.
            // Native action input applies the game's cooldown and interaction rules instead.
            Press("action");
            Finish("special_input_submitted");
            return;
        }
        player.lastClick = monster.Tile * 64 + new Vector2(32, 32);
        player.BeginUsingTool();
    }

    private SButton ResolveButton(string semantic)
    {
        if (semantic.StartsWith("key:", StringComparison.Ordinal))
        {
            var key = semantic[4..];
            if (new[] { "Up", "Down", "Left", "Right", "Space", "Enter", "Escape", "Z", "X", "C", "A", "S", "D", "W", "LeftShift", "LeftControl" }.Contains(key)
                && Enum.TryParse<SButton>(key, out var literal)) return literal;
            throw new ArgumentException("Unsupported native game key");
        }
        var field = semantic switch {
            "use_tool" => "useToolButton", "action" => "actionButton", "cancel" => "cancelButton",
            "move_up" => "moveUpButton", "move_down" => "moveDownButton", "move_left" => "moveLeftButton", "move_right" => "moveRightButton",
            "run" => "runButton", "menu" => "menuButton", "journal" => "journalButton", "map" => "mapButton", "toolbar_swap" => "toolbarSwap",
            _ => throw new ArgumentException("Unknown semantic input button"),
        };
        foreach (var binding in R.Items(R.Get(Game1.options, field)))
        {
            if (R.Bool(binding, "mouseLeft")) return SButton.MouseLeft;
            if (R.Bool(binding, "mouseRight")) return SButton.MouseRight;
            var key = R.Text(binding, "key");
            if (key != "None" && Enum.TryParse<SButton>(key, out var button)) return button;
        }
        throw new InvalidOperationException($"No usable configured input binding for {semantic}");
    }

    private void Press(string semantic) => helper.Input.Press(ResolveButton(semantic));

    public void Cancel(string reason) { if (job is not null) Finish(reason); }
    private void Finish(string reason)
    {
        var current = job;
        if (current is null) return;
        object? after = null; object? fishing = null;
        try {
            after = Context.IsWorldReady ? GameFacts.ControlState() : null;
            fishing = current.Fishing is null ? null : FishingEvidence(current);
        }
        catch { reason = "controller_error:ObservationUnavailable"; }
        job = null;
        current.Completion.TrySetResult(new {
            reason, controller = current.Kind, ticks = current.Ticks,
            sawFishingMinigame = current.SawMinigame, sawNativeCatch = current.SawCaught,
            before = current.Before, after,
            completedWorkflow = false,
            nativeActionSubmitted = current.Submitted,
            completionUncertain = (current.Kind is "dsh_animal" or "dsh_fish" or "dsh_dialogue" or "dsh_quest_ui" or "dsh_consume" or "dsh_craft" or "dsh_storage_ui" or "dsh_shop_ui" or "dsh_shipping" or "dsh_mine_travel") && current.Submitted,
            fishing,
            note = "Controller stopped. Compare inventory/progress to confirm outcomes; no automatic replay on cancellation or timeout.",
        });
    }
}
