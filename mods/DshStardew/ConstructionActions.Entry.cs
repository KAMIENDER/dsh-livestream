using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace DshStardew;

internal static partial class ConstructionActions
{
    private sealed record EntryState(string Phase, string? Builder, string Revision, string? QuestionKey, object Dialogue,
        string[] LocationIds, int? Page, string? PagedDigest);
    private static bool EntryText(string? value) => value is { Length: > 0 and <= 160 } && !value.Any(char.IsControl);
    private static string? StationBuilder(int x, int y) => Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false) switch {
        "Carpenter" => "Robin", "WizardBook" => "Wizard", _ => null,
    };
    private static bool StationClear(int x, int y) => !Game1.currentLocation.Objects.ContainsKey(new Vector2(x, y))
        && !Game1.currentLocation.characters.Any(n => n.GetBoundingBox().Intersects(new Rectangle(x * 64, y * 64, 64, 64)))
        && !AnimalCare.In(Game1.currentLocation).Any(n => n.GetBoundingBox().Intersects(new Rectangle(x * 64, y * 64, 64, 64)));
    private static string StationDigest(int x, int y) => Hash(new { sourceKey = MineActions.Key(Game1.currentLocation), x, y,
        action = Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false),
        objectKey = Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var item) ? MineActions.Key(item) : null });
    private static EntryState EntrySnapshot()
    {
        var source = Game1.currentLocation; var dialogue = SocialActions.Dialogue();
        var box = Game1.activeClickableMenu?.GetType() == typeof(DialogueBox) && Game1.activeClickableMenu.GetChildMenu() is null ? (DialogueBox)Game1.activeClickableMenu : null;
        var phase = "unavailable"; string? builder = null; string[] locations = Array.Empty<string>(); int? page = null; string? pagedDigest = null;
        var questionKey = box?.isQuestion == true ? source.lastQuestionKey : null;
        if (Menu() is { } menu) { phase = "catalogue"; builder = menu.Builder; }
        else if (box?.isQuestion == true && source.afterQuestion is null && questionKey == "carpenter"
            && box.responses is { Length: > 0 and <= 256 } && box.responses.Any(r => r.responseKey == "Construct") && box.responses.Any(r => r.responseKey == "Leave"))
        { phase = "service_question"; builder = "Robin"; }
        else if (box?.isQuestion == true && source.afterQuestion is null && questionKey == "pagedResponse"
            && R.Raw(typeof(GameLocation), "_OnPagedResponse") is Delegate callback && callback.GetInvocationList().Length == 1
            && ReferenceEquals(callback.Target, source) && callback.Method.DeclaringType == typeof(GameLocation)
            && callback.Method.Name == "<ShowConstructOptions>b__448_0" && callback.Method.Module == typeof(Game1).Module)
        {
            // Read the game's existing selector callback/cache. A key or game
            // text alone is not proof that a generic paged question constructs.
            builder = R.Get(source, "_constructLocationBuilderName") as string;
            var pairs = R.Items(R.Raw(typeof(GameLocation), "_PagedResponses")).Take(513).ToArray();
            var ids = pairs.Select(p => R.Get(p, "Key") as string).ToArray();
            if (builder is "Robin" or "Wizard" && pairs.Length is > 0 and <= 512 && ids.All(EntryText)
                && ids.Distinct(StringComparer.Ordinal).Count() == ids.Length && ids.All(id => id is not "nextPage" and not "previousPage" and not "cancel")
                && R.Get(typeof(GameLocation), "_PagedResponsePage") is int actualPage && actualPage >= 0
                && R.Get(typeof(GameLocation), "_PagedResponseItemsPerPage") is int pageSize && pageSize is > 0 and <= 20)
            {
                phase = "location_question"; locations = ids.Select(id => id!).ToArray(); page = actualPage;
                pagedDigest = Hash(new { builder, callbackKey = MineActions.Key(callback), sourceKey = MineActions.Key(source), pageSize,
                    prompt = R.Get(typeof(GameLocation), "_PagedResponsePrompt"),
                    rows = pairs.Select(p => new { key = R.Get(p, "Key"), text = R.Get(p, "Value") }).ToArray() });
            }
        }
        var revision = Hash(new { state = MineActions.State(), sourceKey = MineActions.Key(source), phase, builder, questionKey, page, pagedDigest,
            activeMenuKey = Game1.activeClickableMenu is { } active ? MineActions.Key(active) : null,
            // Typing and option visibility advance naturally. Bind the same
            // actual box/text/response semantics, not those transient flags;
            // readiness and current response bounds are rechecked before input.
            question = box is null ? null : new { text = box.getCurrentString(), box.isQuestion, box.x, box.y, box.width, box.height,
                responses = (box.responses ?? Array.Empty<Response>()).Select(r => new { r.responseKey, r.responseText }).ToArray() },
            viewport = new { Game1.uiViewport.Width, Game1.uiViewport.Height },
            afterQuestion = source.afterQuestion is null ? null : MineActions.Key(source.afterQuestion) });
        return new(phase, builder, revision, questionKey, dialogue, locations, page, pagedDigest);
    }
    private static object QueryEntry(JsonElement args)
    {
        var source = Game1.currentLocation; var layer = source.Map.Layers[0]; var points = new List<Point>();
        if (args.TryGetProperty("entryPosition", out var entryPosition))
        {
            // The parent query may inspect the farm while the actor is still
            // at the builder. A no-longer-current entry is not relocated.
            if (R.Arg(entryPosition, "locationId") == source.NameOrUniqueName)
                points.Add(new Point(R.Int(entryPosition, "x", -1, 0, layer.LayerWidth - 1), R.Int(entryPosition, "y", -1, 0, layer.LayerHeight - 1)));
        }
        else for (var y = Math.Max(0, (int)Game1.player.Tile.Y - 6); y <= Math.Min(layer.LayerHeight - 1, (int)Game1.player.Tile.Y + 6); y++)
            for (var x = Math.Max(0, (int)Game1.player.Tile.X - 6); x <= Math.Min(layer.LayerWidth - 1, (int)Game1.player.Tile.X + 6); x++) points.Add(new Point(x, y));
        var state = EntrySnapshot();
        return new { state.Phase, state.Builder, state.Revision, state.QuestionKey, state.Dialogue, state.LocationIds, state.Page, state.PagedDigest,
            sourceLocationId = source.NameOrUniqueName, sourceLocationKey = MineActions.Key(source),
            sourceWidth = layer.LayerWidth, sourceHeight = layer.LayerHeight,
            stations = points.Where(p => StationBuilder(p.X, p.Y) is not null).Select(p => new {
                position = new { locationId = source.NameOrUniqueName, x = p.X, y = p.Y }, builder = StationBuilder(p.X, p.Y),
                action = source.doesTileHaveProperty(p.X, p.Y, "Action", "Buildings", false), stationDigest = StationDigest(p.X, p.Y), clear = StationClear(p.X, p.Y),
                approach = StationBuilder(p.X, p.Y) == "Robin" ? "south_adjacent" : "adjacent",
                note = "Normal native action still checks builder presence, construction/house work and wizard ink unlock; no eligibility bypass." }).ToArray() };
    }
    internal sealed class EntryAttempt
    {
        public string Operation = "", Builder = "", Save = "", Day = "", Revision = "", InventoryDigest = "", BuildingsDigest = "", Station = "", Text = "", ResponseKey = "", ResponseText = "";
        public string? PagedDigest;
        public GameLocation Source = null!, Target = null!;
        public DialogueBox? Box;
        public WorldInteraction? World;
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public object Before = null!;
        public Vector2 StartTile;
        public Point Pointer;
        public int Gold, Health, X, Y, Slot = -1, StableTicks;
        public int? Page;
        public float Energy;
        public bool Started, Submitted;
    }
    internal static EntryAttempt PrepareEntry(JsonElement args)
    {
        InventoryActions.Require(WorldReady() && Game1.player.Items.Count <= 256 && !Game1.eventUp && !Game1.IsFading()
            && R.Get(typeof(Game1), "currentMinigame") is null, "Construction entry requires a supported normal world");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] {
            "operation", "builder", "targetLocationId", "revision", "position", "stationDigest", "expectedText", "responseKey", "responseText", "inventoryDigest", "structureDigest", "expectedGold",
        }.Contains(p.Name)), "Unknown construction entry argument");
        var state = EntrySnapshot(); var source = Game1.currentLocation; var operation = R.Arg(args, "operation"); var builder = R.Arg(args, "builder");
        InventoryActions.Require(builder is "Robin" or "Wizard" && new[] { "open", "reveal", "choose_construct", "choose_location", "next_page", "previous_page", "leave" }.Contains(operation)
            && state.Revision == R.Arg(args, "revision"), "Actual construction entry identity or operation changed");
        InventoryActions.Require(operation == "leave" || Game1.timeOfDay < 2200 && Game1.player.health >= 20 && Game1.player.Stamina >= 30, "Only leaving the known question is allowed at closing/resource limits");
        var target = Target(R.Arg(args, "targetLocationId"));
        var a = new EntryAttempt { Operation = operation, Builder = builder, Source = source, Target = target, Save = GameFacts.SaveId(), Day = GameFacts.DayKey(),
            Revision = state.Revision, InventoryDigest = InventoryActions.Digest(), Inventory = InventoryActions.Counts(), BuildingsDigest = Hash(Structures(target)),
            Gold = Game1.player.Money, Health = Game1.player.health, Energy = Game1.player.Stamina, StartTile = Game1.player.Tile, Page = state.Page, PagedDigest = state.PagedDigest };
        InventoryActions.Require(a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.BuildingsDigest == R.Arg(args, "structureDigest")
            && a.Gold == R.Int(args, "expectedGold", -1, 0, int.MaxValue), "Entry inventory, buildings or gold changed");
        if (operation == "open")
        {
            InventoryActions.Require(Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool
                && args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == source.NameOrUniqueName, "Use the actual current-location building counter/book");
            var position = args.GetProperty("position"); a.X = R.Int(position, "x", -1, 0, source.Map.Layers[0].LayerWidth - 1); a.Y = R.Int(position, "y", -1, 0, source.Map.Layers[0].LayerHeight - 1);
            a.Station = StationDigest(a.X, a.Y);
            InventoryActions.Require(StationBuilder(a.X, a.Y) == builder && a.Station == R.Arg(args, "stationDigest") && StationClear(a.X, a.Y)
                && Math.Abs(a.StartTile.X - a.X) + Math.Abs(a.StartTile.Y - a.Y) == 1 && (builder != "Robin" || a.StartTile.Y == a.Y + 1),
                "Stand at the exact unobstructed native entry; Robin's counter requires its south adjacent tile");
            a.Slot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(i => Game1.player.Items[i] is null || Game1.player.Items[i] is Tool, -1);
            InventoryActions.Require(a.Slot >= 0, "Use an actual empty/tool slot, not a gift or placeable item");
        }
        else
        {
            InventoryActions.Require(state.Builder == builder && (state.Phase is "service_question" or "location_question") && Game1.activeClickableMenu?.GetType() == typeof(DialogueBox), "Use the actual inspected native construction question");
            a.Box = (DialogueBox)Game1.activeClickableMenu; a.Text = R.Arg(args, "expectedText");
            InventoryActions.Require(a.Text == R.Text(state.Dialogue, "text"), "Exact current question text changed");
            if (operation == "reveal") InventoryActions.Require(!R.Bool(state.Dialogue, "revealed"), "Question is already revealed");
            else
            {
                a.ResponseKey = R.Arg(args, "responseKey"); a.ResponseText = R.Arg(args, "responseText");
                var allowed = operation switch {
                    "choose_construct" => state.Phase == "service_question" && builder == "Robin" && a.ResponseKey == "Construct",
                    "choose_location" => state.Phase == "location_question" && a.ResponseKey == target.NameOrUniqueName && state.LocationIds.Contains(a.ResponseKey),
                    "next_page" => state.Phase == "location_question" && a.ResponseKey == "nextPage",
                    "previous_page" => state.Phase == "location_question" && a.ResponseKey == "previousPage",
                    "leave" => a.ResponseKey == (state.Phase == "service_question" ? "Leave" : "cancel"), _ => false,
                };
                InventoryActions.Require(allowed && R.Bool(state.Dialogue, "choicesReady"), "Only the exact construct/location/page/leave response is authorized");
                var responses = a.Box.responses ?? Array.Empty<Response>();
                InventoryActions.Require(responses.Count(r => r.responseKey == a.ResponseKey && r.responseText == a.ResponseText) == 1, "Exact visible response is missing or duplicated");
            }
        }
        a.Before = Query(JsonSerializer.SerializeToElement(new { locationId = target.NameOrUniqueName })); return a;
    }
    internal static bool EntryContext(EntryAttempt a) => WorldReady() && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day
        && ReferenceEquals(Game1.currentLocation, a.Source) && Game1.player.Tile == a.StartTile;
    internal static bool EntryResources(EntryAttempt a) => EntryContext(a) && InventoryActions.Digest() == a.InventoryDigest && Hash(Structures(a.Target)) == a.BuildingsDigest
        && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy && !Game1.IsFading() && !Game1.eventUp;
    internal static bool BeforeEntryInput(EntryAttempt a) => EntryResources(a) && (a.Operation == "open" ? Game1.activeClickableMenu is null && Context.CanPlayerMove
        && !Game1.player.UsingTool && StationBuilder(a.X, a.Y) == a.Builder && StationDigest(a.X, a.Y) == a.Station && StationClear(a.X, a.Y)
        : ReferenceEquals(Game1.activeClickableMenu, a.Box) && EntrySnapshot().Revision == a.Revision);
    internal static Point? EntryPointer(EntryAttempt a)
    {
        var state = EntrySnapshot(); if (!R.Bool(state.Dialogue, "ready")) return null;
        var box = a.Box ?? throw new InvalidOperationException("No actual construction question"); Point p;
        if (a.Operation == "reveal") p = new Point(box.x + box.width / 2, box.y + box.height - 24);
        else
        {
            var rs = box.responses ?? Array.Empty<Response>(); var index = Array.FindIndex(rs, r => r.responseKey == a.ResponseKey && r.responseText == a.ResponseText);
            InventoryActions.Require(R.Bool(state.Dialogue, "choicesReady") && box.responseCC is not null && box.responseCC.Count == rs.Length && index >= 0
                && box.responseCC[index].visible, "Actual question response is not ready/visible"); p = box.responseCC[index].bounds.Center;
        }
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Actual construction response is off screen"); return p;
    }
    internal static void ExecuteEntry(EntryAttempt a, Point p)
    {
        InventoryActions.Require(BeforeEntryInput(a) && EntryPointer(a) == p, "Question changed before native input"); a.Started = true; a.Submitted = true;
        var box = a.Box!; box.performHoverAction(p.X, p.Y);
        if (a.Operation == "reveal") box.finishTyping(); else box.receiveLeftClick(p.X, p.Y, false);
        if (ReferenceEquals(Game1.activeClickableMenu, box)) box.releaseLeftClick(p.X, p.Y);
    }
    internal static bool EntrySettled(EntryAttempt a)
    {
        if (!EntryContext(a) || Game1.IsFading()) return false;
        var state = EntrySnapshot(); var menu = Menu();
        var catalogue = menu is not null && menu.Builder == a.Builder && ReferenceEquals(menu.TargetLocation, a.Target) && !menu.onFarm && !menu.freeze;
        var anyCatalogue = menu is not null && menu.Builder == a.Builder && !menu.onFarm && !menu.freeze;
        return a.Operation switch {
            "open" => anyCatalogue || state.Builder == a.Builder && (state.Phase is "service_question" or "location_question")
                || Game1.activeClickableMenu is null && Context.CanPlayerMove
                || Game1.activeClickableMenu?.GetType() == typeof(DialogueBox) && state.Phase == "unavailable"
                || Game1.activeClickableMenu?.GetType() == typeof(ShopMenu),
            "reveal" => ReferenceEquals(a.Box, Game1.activeClickableMenu) && R.Bool(state.Dialogue, "revealed") && R.Bool(state.Dialogue, "choicesReady"),
            "choose_construct" => anyCatalogue || state.Phase == "location_question" && state.Builder == a.Builder,
            "choose_location" => catalogue,
            "next_page" => state.Phase == "location_question" && state.Builder == a.Builder && state.PagedDigest == a.PagedDigest && state.Page == a.Page + 1,
            "previous_page" => state.Phase == "location_question" && state.Builder == a.Builder && state.PagedDigest == a.PagedDigest && state.Page == a.Page - 1,
            "leave" => Game1.activeClickableMenu is null && Context.CanPlayerMove, _ => false,
        };
    }
    internal static object FinishEntry(EntryAttempt a)
    {
        var state = EntrySnapshot(); var changes = InventoryActions.Changes(a.Inventory);
        var confirmed = a.Started && (a.Operation != "open" || a.World?.Pressed == true) && EntryResources(a) && EntrySettled(a) && changes.Length == 0;
        var menu = Menu(); var available = confirmed && (state.Builder == a.Builder && (state.Phase is "service_question" or "location_question")
            || menu is not null && menu.Builder == a.Builder && ReferenceEquals(menu.TargetLocation, a.Target));
        return new { completedWorkflow = confirmed, confirmedEffect = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Started,
            nativeInputSubmitted = a.Operation == "open" ? a.World?.Pressed == true : a.Submitted, operation = a.Operation, entryAvailable = available,
            targetLocationId = a.Target.NameOrUniqueName, builder = a.Builder, before = a.Before,
            after = Query(JsonSerializer.SerializeToElement(new { locationId = a.Target.NameOrUniqueName })), inventoryChanges = changes, goldBefore = a.Gold, goldAfter = Game1.player.Money,
            note = "Normal native counter/book input or exact actual construction question only. No direct ShowConstructOptions, menu construction, callback invocation, unlock edits or spending. Unavailable feedback is not a catalogue; unknown outcomes are never replayed." };
    }
}
