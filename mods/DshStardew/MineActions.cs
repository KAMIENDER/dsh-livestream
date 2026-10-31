using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>Observe real mine tiles; travel exclusively through normal input and native displayed menus.</summary>
internal static class MineActions
{
    private const string Build = "e2d77e0c-417e-41ec-b5ab-ab6e915ce317";
    private sealed class Tag { public string Value { get; } = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Tag> Keys = new();
    internal static string Key(object value) => Keys.GetValue(value, _ => new Tag()).Value;
    private static bool Supported() => typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D") == Build;
    private static string? Kind(int tile) => tile switch { 173 => "descend", 115 => "leave", 174 => "shaft", 112 => "elevator", _ => null };
    internal sealed record Exit(string TargetKey, string Digest, string Kind, string LocationId, int X, int Y, int TileIndex, bool Blocked);
    private static Exit? At(MineShaft mine, int x, int y)
    {
        // MineShaft.checkAction uses Buildings AND tile-sheet ID "mine", not a
        // textual Action property. Index 174 creates a question, not a safe ladder.
        var index = mine.getTileIndexAt(x, y, "Buildings", "mine"); var kind = Kind(index);
        if (kind is null) return null;
        var tile = new Vector2(x, y);
        var blocked = mine.Objects.ContainsKey(tile) || mine.terrainFeatures.ContainsKey(tile) || mine.characters.Any(c => (int)c.Tile.X == x && (int)c.Tile.Y == y)
            || mine.doesTileHaveProperty(x, y, "Action", "Buildings") is not null || mine.doesTileHaveProperty(x, y, "TouchAction", "Back") is not null;
        var digest = GameFacts.Hash(JsonSerializer.Serialize(new { location = Key(mine), map = Key(mine.Map), mine.mineLevel, x, y, index,
            blocked,
            occupied = mine.Objects.ContainsKey(tile), terrain = mine.terrainFeatures.ContainsKey(tile),
            action = mine.doesTileHaveProperty(x, y, "Action", "Buildings"), touch = mine.doesTileHaveProperty(x, y, "TouchAction", "Back") }, LocalServer.Json));
        return new Exit(GameFacts.Hash($"{Key(mine)}|{Key(mine.Map)}|{x}|{y}|{index}"), digest, kind, mine.NameOrUniqueName, x, y, index, blocked);
    }
    internal static object State() => new { locationId = Game1.currentLocation.NameOrUniqueName, locationKey = Key(Game1.currentLocation),
        level = Game1.currentLocation is MineShaft m ? (int?)m.mineLevel : null, position = new { locationId = Game1.currentLocation.NameOrUniqueName, x = (int)Game1.player.Tile.X, y = (int)Game1.player.Tile.Y },
        canMove = Context.CanPlayerMove && !Game1.player.UsingTool, health = Game1.player.health, energy = Game1.player.Stamina, money = Game1.player.Money,
        inventoryDigest = InventoryActions.Digest(), inventoryCounts = InventoryActions.Counts(), menuType = Game1.activeClickableMenu?.GetType().FullName, fading = Game1.fadeToBlack, eventUp = Game1.eventUp };

    public static object Query()
    {
        var state = State();
        if (!Supported() || Game1.currentLocation.GetType() != typeof(MineShaft)) return new { available = false, state, reason = "unsupported_build_or_not_native_mine_shaft" };
        var mine = (MineShaft)Game1.currentLocation; var layer = mine.Map.Layers[0];
        if (layer.LayerWidth is < 1 or > 256 || layer.LayerHeight is < 1 or > 256) return new { available = false, state, reason = "mine_map_exceeds_complete_bounds" };
        var exits = new List<Exit>();
        for (var y = 0; y < layer.LayerHeight; y++) for (var x = 0; x < layer.LayerWidth; x++)
            if (At(mine, x, y) is { } exit) { if (exits.Count == 256) return new { available = false, state, reason = "mine_exits_exceed_complete_bounds" }; exits.Add(exit); }
        return new { available = true, complete = true, state, width = layer.LayerWidth, height = layer.LayerHeight, exits,
            lowestLevelReached = R.Get(typeof(MineShaft), "lowestLevelReached"),
            note = "Complete native mine exit tile scan, not reachability, a generated ladder, or full exploration. Shaft fall is random and damages health; elevator buttons are verified only after normal opening." };
    }

    internal sealed class Attempt
    {
        public MineShaft Mine = null!;
        public object Map = null!;
        public Exit Exit = null!;
        public string Operation = "", Save = "", Day = "";
        public int Destination, HealthFloor, MaxHealthLoss, MaxLevelAfter, Health, Money, NeutralSlot;
        public int LastHealth, ObservedHealthLoss;
        public float Energy;
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public string InventoryDigest = "";
        public object Before = null!;
        public WorldInteraction? World;
        public IClickableMenu? ChoiceMenu;
        public string? MenuDigest;
        public bool ChoiceClicked, FallMessageClosed;
        public int StableTicks;
        public string Stable = "";
        public bool Submitted => World?.Pressed == true;
    }

    public static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(Supported() && Game1.currentLocation.GetType() == typeof(MineShaft)
            && Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.fadeToBlack && !Game1.player.UsingTool,
            "Native mine travel requires an idle single-player mine in the inspected build");
        InventoryActions.Require(args.EnumerateObject().All(p => new[] { "operation", "position", "locationKey", "targetKey", "targetDigest", "expectedFromLevel", "expectedHealth", "expectedMoney", "inventoryDigest", "destinationLevel", "healthFloor", "maxHealthLoss", "maxLevelAfter", "durationMs" }.Contains(p.Name)), "Unknown mine travel argument");
        var mine = (MineShaft)Game1.currentLocation;
        InventoryActions.Require(args.TryGetProperty("position", out var p) && p.ValueKind == JsonValueKind.Object && R.Arg(p, "locationId") == mine.NameOrUniqueName, "Mine target location changed");
        var x = R.Int(p, "x", -1, 0, mine.Map.Layers[0].LayerWidth - 1); var y = R.Int(p, "y", -1, 0, mine.Map.Layers[0].LayerHeight - 1);
        var exit = At(mine, x, y); var op = R.Arg(args, "operation");
        InventoryActions.Require(exit is not null && !exit.Blocked && exit.Kind == op && exit.TargetKey == R.Arg(args, "targetKey") && exit.Digest == R.Arg(args, "targetDigest")
            && Key(mine) == R.Arg(args, "locationKey") && mine.mineLevel == R.Int(args, "expectedFromLevel", -1, 1, 1000000), "Exact mine instance, level or exit changed");
        var a = new Attempt { Mine = mine, Map = mine.Map, Exit = exit!, Operation = op, Save = GameFacts.SaveId(), Day = GameFacts.DayKey(),
            Destination = R.Int(args, "destinationLevel", 0, 0, 120), HealthFloor = R.Int(args, "healthFloor", 30, 1, 1000),
            MaxHealthLoss = R.Int(args, "maxHealthLoss", 0, 0, 1000), MaxLevelAfter = R.Int(args, "maxLevelAfter", mine.mineLevel + 1, 1, 1000000),
            Health = Game1.player.health, Money = Game1.player.Money, Energy = Game1.player.Stamina,
            Inventory = InventoryActions.Counts(), InventoryDigest = InventoryActions.Digest(), Before = State() };
        a.LastHealth = a.Health;
        InventoryActions.Require(a.Health == R.Int(args, "expectedHealth", -1, 1, 1000) && a.Money == R.Int(args, "expectedMoney", -1, 0, int.MaxValue)
            && a.InventoryDigest == R.Arg(args, "inventoryDigest"), "Observed health, gold or complete inventory changed before native travel");
        InventoryActions.Require(Math.Abs(x - (int)Game1.player.Tile.X) + Math.Abs(y - (int)Game1.player.Tile.Y) == 1
            && !mine.Objects.ContainsKey(new Vector2(x, y)) && !mine.terrainFeatures.ContainsKey(new Vector2(x, y)), "Stand exactly adjacent to an unoccupied native exit");
        InventoryActions.Require(a.Health >= a.HealthFloor && (op == "leave" || mine.mineLevel != 77377), "Health floor or quarry cave operation is unsupported");
        InventoryActions.Require(op != "shaft" || mine.mineLevel > 120 && a.MaxHealthLoss >= 45 && a.Health >= a.HealthFloor + 45 && a.MaxLevelAfter >= mine.mineLevel + 15,
            "A shaft needs explicit room for up to 15 levels and 45 native health loss above the floor");
        InventoryActions.Require(op != "descend" || a.MaxLevelAfter >= mine.mineLevel + 1, "Next floor exceeds the allowed level bound");
        InventoryActions.Require(op != "elevator" || mine.mineLevel <= 120 && a.Destination % 5 == 0 && a.Destination != mine.mineLevel
            && a.Destination <= Math.Max(0, Math.Min(120, (int)R.Number(typeof(MineShaft), "lowestLevelReached"))) / 5 * 5 && a.Destination <= a.MaxLevelAfter,
            "Select a distinct ordinary-mine elevator floor; its actual native button must exist");
        a.NeutralSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(i => Game1.player.Items[i] is null, -1);
        if (a.NeutralSlot < 0) a.NeutralSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(i => Game1.player.Items[i] is Pickaxe or Axe or Hoe or WateringCan, -1);
        InventoryActions.Require(a.NeutralSlot >= 0, "Use an actual empty or non-weapon work-tool slot for native interaction");
        return a;
    }

    public static bool BeforeInput(Attempt a) => ReferenceEquals(Game1.currentLocation, a.Mine) && ReferenceEquals(a.Mine.Map, a.Map)
        && At(a.Mine, a.Exit.X, a.Exit.Y) is { } e && !e.Blocked && e.TargetKey == a.Exit.TargetKey && e.Digest == a.Exit.Digest
        && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Money && Game1.player.health >= a.HealthFloor + (a.Operation == "shaft" ? 45 : 0)
        && (a.Operation == "leave" || a.Operation == "elevator" && a.Destination == 0 || Game1.timeOfDay < 2200 && Game1.player.Stamina >= 30);

    private static bool MouseReady(Point p) => Math.Abs(Game1.getMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getMouseY(true) - p.Y) <= 2
        && Math.Abs(Game1.getOldMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getOldMouseY(true) - p.Y) <= 2;
    private static bool SafeBox(DialogueBox box) => box.GetType() == typeof(DialogueBox) && box.GetChildMenu() is null && box.characterDialogue is null
        && R.Get(typeof(Game1), "afterDialogues") is null && R.Get(Game1.currentLocation, "afterQuestion") is null;
    private static string MenuDigest(IClickableMenu menu, Point point, string selection) => GameFacts.Hash(JsonSerializer.Serialize(new { menu = Key(menu), selection, point }, LocalServer.Json));

    /// <summary>One exact choice in the menu opened by this attempt, never an arbitrary dialogue response.</summary>
    public static void Choose(Attempt a)
    {
        var menu = Game1.activeClickableMenu;
        if (menu is null || a.ChoiceClicked) return;
        InventoryActions.Require(ReferenceEquals(Game1.currentLocation, a.Mine) && !Game1.eventUp && menu.GetChildMenu() is null, "Mine choice context changed");
        Point pointer; string selection;
        if (a.Operation == "elevator")
        {
            InventoryActions.Require(menu.GetType() == typeof(MineElevatorMenu), "Expected the normally opened mine elevator");
            var buttons = R.Items(R.Get(menu, "elevators")).OfType<ClickableComponent>().Where(b => b.visible
                && int.TryParse(b.name, NumberStyles.None, CultureInfo.InvariantCulture, out var level) && level == a.Destination).ToArray();
            InventoryActions.Require(buttons.Length == 1 && a.Destination <= a.MaxLevelAfter, "Requested native elevator button is absent or exceeds the bound");
            pointer = buttons[0].bounds.Center; selection = buttons[0].name;
        }
        else
        {
            InventoryActions.Require(menu is DialogueBox d && SafeBox(d) && d.isQuestion
                && R.Text(a.Mine, "lastQuestionKey") == (a.Operation == "leave" ? "ExitMine" : "Shaft"), "Expected this exit's native question with no custom callback");
            var box = (DialogueBox)menu;
            if (box.transitioning || box.safetyTimer > 0 || box.characterAdvanceTimer > 0 || box.questionFinishPauseTimer > 0) return;
            if (box.characterIndexInDialogue < box.getCurrentString().Length - 1) { box.finishTyping(); return; }
            if (!R.Bool(box, "_showedOptions")) return;
            selection = a.Operation == "leave" ? "Leave" : "Jump";
            InventoryActions.Require(box.responses is not null && box.responseCC is not null && box.responses.Length == box.responseCC.Count, "Native mine responses are incomplete");
            var matches = Enumerable.Range(0, box.responses.Length).Where(i => box.responses[i].responseKey == selection && box.responseCC[i].visible).ToArray();
            InventoryActions.Require(matches.Length == 1, "Exact native mine response is not unique/visible"); pointer = box.responseCC[matches[0]].bounds.Center;
            selection += "|" + box.getCurrentString() + "|" + box.responses[matches[0]].responseText;
        }
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(pointer), "Native mine choice is outside the viewport");
        var digest = MenuDigest(menu, pointer, selection);
        if (a.ChoiceMenu is null) { a.ChoiceMenu = menu; a.MenuDigest = digest; Game1.setMousePosition(pointer.X, pointer.Y, true); return; }
        InventoryActions.Require(ReferenceEquals(a.ChoiceMenu, menu) && a.MenuDigest == digest && BeforeInput(a), "Native mine menu, response or resource context changed before clicking");
        if (!MouseReady(pointer)) return;
        a.ChoiceClicked = true;
        menu.performHoverAction(pointer.X, pointer.Y); menu.receiveLeftClick(pointer.X, pointer.Y, false);
        if (ReferenceEquals(Game1.activeClickableMenu, menu)) menu.releaseLeftClick(pointer.X, pointer.Y);
    }

    public static void CloseFallMessage(Attempt a)
    {
        if (a.FallMessageClosed || Game1.activeClickableMenu is null) return;
        var fallen = (int)R.Number(a.Mine, "lastLevelsDownFallen");
        var expected = Game1.content.LoadString(fallen > 7 ? "Strings\\Locations:Mines_FallenFar" : "Strings\\Locations:Mines_Fallen", fallen);
        InventoryActions.Require(a.Operation == "shaft" && a.ChoiceClicked && fallen is >= 1 and <= 15
            && Game1.activeClickableMenu is DialogueBox d && SafeBox(d) && !d.isQuestion && d.getCurrentString() == expected
            && d.dialogues is not null && d.dialogues.Count == 1, "Only this native fall message may be closed");
        var box = (DialogueBox)Game1.activeClickableMenu;
        if (box.transitioning || box.safetyTimer > 0 || box.characterAdvanceTimer > 0) return;
        if (box.characterIndexInDialogue < expected.Length - 1) { box.finishTyping(); return; }
        var pointer = new Point(box.x + box.width / 2, box.y + box.height / 2);
        var digest = MenuDigest(box, pointer, expected);
        if (!ReferenceEquals(a.ChoiceMenu, box)) { a.ChoiceMenu = box; a.MenuDigest = digest; Game1.setMousePosition(pointer.X, pointer.Y, true); return; }
        InventoryActions.Require(a.MenuDigest == digest && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(pointer), "Fall message geometry or text changed");
        if (!MouseReady(pointer)) return;
        a.FallMessageClosed = true; box.receiveLeftClick(pointer.X, pointer.Y, false);
        if (ReferenceEquals(Game1.activeClickableMenu, box)) box.releaseLeftClick(pointer.X, pointer.Y);
    }

    public static bool DestinationMatches(Attempt a)
    {
        if (ReferenceEquals(Game1.currentLocation, a.Mine)) return false;
        if (a.Operation == "leave" || a.Operation == "elevator" && a.Destination == 0)
            return Game1.currentLocation is not MineShaft && Game1.currentLocation.NameOrUniqueName == (a.Mine.mineLevel > 120 && a.Mine.mineLevel != 77377 ? "SkullCave" : "Mine");
        if (Game1.currentLocation.GetType() != typeof(MineShaft)) return false;
        var next = ((MineShaft)Game1.currentLocation).mineLevel;
        return next <= a.MaxLevelAfter && (a.Operation == "descend" ? next == a.Mine.mineLevel + 1 : a.Operation == "elevator" ? next == a.Destination
            : a.ChoiceClicked && next - a.Mine.mineLevel == (int)R.Number(a.Mine, "lastLevelsDownFallen") && next - a.Mine.mineLevel is >= 1 and <= 15);
    }

    public static object Finish(Attempt a)
    {
        var changes = InventoryActions.Changes(a.Inventory); var loss = Math.Max(0, a.Health - Game1.player.health);
        var confirmed = DestinationMatches(a) && Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.fadeToBlack
            && Game1.player.health >= a.HealthFloor && a.ObservedHealthLoss <= a.MaxHealthLoss && Game1.player.Money == a.Money && Game1.player.Stamina >= a.Energy
            && changes.All(c => c.Amount >= 0) && (a.Operation != "shaft" || a.FallMessageClosed);
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed, operation = a.Operation, nativeActionSubmitted = a.Submitted,
            before = a.Before, after = State(), inventoryChanges = changes, beforeGold = a.Money, afterGold = Game1.player.Money, healthLoss = loss, observedHealthLoss = a.ObservedHealthLoss,
            nativeFallLevels = a.Operation == "shaft" ? (int?)R.Number(a.Mine, "lastLevelsDownFallen") : null,
            note = "Only this observed native transition; no ladder generation, direct warp, invulnerability, mining/kill proof or complete exploration. Positive incidental pickups are reported, never invented as mined production." };
    }
}
