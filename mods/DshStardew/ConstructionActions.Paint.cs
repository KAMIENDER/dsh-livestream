using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Menus;

namespace DshStardew;

internal static partial class ConstructionActions
{
    internal sealed record PaintRegion(int Index, bool Default, int Hue, int Saturation, int Lightness);
    internal sealed record PaintColors(string Name, PaintRegion[] Regions);
    private static PaintColors Colors(Building b)
    {
        var color = R.Get(b, "netBuildingPaintColor");
        InventoryActions.Require(color?.GetType() == typeof(BuildingPaintColor), "Missing actual native building color target");
        var rows = Enumerable.Range(1, 3).Select(i => {
            InventoryActions.Require(R.Get(color, $"Color{i}Default") is bool, "Unknown paint default flag");
            return new PaintRegion(i - 1, R.Bool(color, $"Color{i}Default"), checked((int)R.Number(color, $"Color{i}Hue")),
                checked((int)R.Number(color, $"Color{i}Saturation")), checked((int)R.Number(color, $"Color{i}Lightness"))); }).ToArray();
        InventoryActions.Require(rows.All(r => r.Hue is >= -10000 and <= 10000 && r.Saturation is >= -10000 and <= 10000 && r.Lightness is >= -10000 and <= 10000), "Unbounded paint fields");
        return new PaintColors(R.Text(color, "ColorName"), rows);
    }
    private static object ColorRoster(GameLocation target) => R.Items(R.Get(target, "buildings")).Cast<Building>()
        .Select(b => new { guid = Fact(b).BuildingGuid, key = MineActions.Key(b), tint = b.color.PackedValue, colors = Colors(b) }).OrderBy(b => b.guid, StringComparer.Ordinal).ToArray();
    private static string PaintProtection(Building b, GameLocation target) => Hash(new { fields = MoveProtected(b, target), exits = MoveExits(b) });
    private static BuildingPaintMenu? PaintMenu(Building b) => RootMenu()?.GetChildMenu() is BuildingPaintMenu p && p.GetType() == typeof(BuildingPaintMenu)
        && p.GetChildMenu() is null && ReferenceEquals(p.building, b) && ReferenceEquals(p.colorTarget, R.Get(b, "netBuildingPaintColor")) ? p : null;
    internal sealed record Slider(string Channel, string Key, int Min, int Max, int Value, Rectangle Bounds);
    private static object ActualSlider(BuildingPaintMenu p, string channel)
    {
        InventoryActions.Require(new[] { "hue", "saturation", "lightness" }.Contains(channel), "Unknown native paint channel");
        var panel = R.Get(p, "colorSliderPanel"); var slider = R.Get(panel, channel + "Slider");
        InventoryActions.Require(panel?.GetType().DeclaringType == typeof(BuildingPaintMenu) && slider?.GetType().DeclaringType == typeof(BuildingPaintMenu)
            && slider.GetType().Name == "BuildingColorSlider" && ReferenceEquals(R.Get(slider, "buildingPaintMenu"), p), "Unknown actual paint slider"); return slider!;
    }
    private static Slider SliderFact(BuildingPaintMenu p, string channel)
    {
        var s = ActualSlider(p, channel); InventoryActions.Require(R.Get(s, "bounds") is Rectangle, "Missing actual slider geometry");
        var r = new Slider(channel, MineActions.Key(s), checked((int)R.Number(s, "min")), checked((int)R.Number(s, "max")),
            checked((int)R.Number(s, "_displayedValue")), (Rectangle)R.Get(s, "bounds")!);
        InventoryActions.Require(r.Min is >= -10000 and <= 10000 && r.Max > r.Min && r.Max <= 10000 && r.Value >= r.Min && r.Value <= r.Max
            && r.Bounds.Width is > 0 and <= 20000 && r.Bounds.Height is > 0 and <= 20000, "Unbounded actual slider range/value"); return r;
    }
    private static object Palette()
    {
        // Called only after an observed native paint child initialized its
        // palette. Do not initialize saved colors or write player/shared data.
        var source = R.Raw(typeof(BuildingPaintMenu), "savedColors"); InventoryActions.Require(source is not null, "Native saved palette is unavailable, not known empty");
        var rows = R.Items(source).Take(65).ToArray();
        InventoryActions.Require(rows.Length <= 64 && rows.All(v => v is Vector3), "Incomplete native saved palette");
        return rows.Cast<Vector3>().Select(v => new { v.X, v.Y, v.Z }).ToArray();
    }
    private static object PaintState(Building b, GameLocation target)
    {
        var p = PaintMenu(b); var entries = p is null ? Array.Empty<object>() : R.Items(R.Get(p, "regions")).Take(4).ToArray();
        InventoryActions.Require(p is null || entries.Length is > 0 and <= 3 && entries.All(r => r.GetType().DeclaringType == typeof(BuildingPaintMenu)), "Unknown/incomplete native paint regions");
        return new { worldRevision = Revision(target), building = Fact(b), colors = Colors(b), legacyTint = b.color.PackedValue, preservationDigest = PaintProtection(b, target), colorRoster = ColorRoster(target),
            ui = p is null ? null : new { key = MineActions.Key(p), currentRegion = p.currentPaintRegion,
                regions = entries.Select((r, i) => new { index = i, id = R.Text(r, "Id"), minBrightness = R.Get(r, "MinBrightness"), maxBrightness = R.Get(r, "MaxBrightness") }).ToArray(),
                sliders = new[] { "hue", "saturation", "lightness" }.Select(c => {
                    var s = SliderFact(p, c); return new { s.Channel, s.Key, s.Min, s.Max, s.Value, s.Bounds,
                        reachableValues = Enumerable.Range(s.Bounds.Left - 1, s.Bounds.Width + 3).Where(x => OnPaintScreen(new Point(x, s.Bounds.Center.Y)))
                            .Select(x => PaintPixelValue(s, x)).Distinct().OrderBy(v => v).ToArray() }; }).ToArray(),
                activeSliderKey = p.activeSlider is null ? null : MineActions.Key(p.activeSlider), paletteDigest = Hash(Palette()),
                controls = new[] { p.okButton, p.nextRegionButton, p.previousRegionButton, p.defaultColorButton }.Select(c => c is null ? null : new { c.visible, bounds = R.Plain(c.bounds) }).ToArray() },
            rootKey = RootMenu() is { } m ? MineActions.Key(m) : null, childType = RootMenu()?.GetChildMenu()?.GetType().FullName };
    }
    private static object? QueryPaint(JsonElement args, GameLocation target)
    {
        if (!args.TryGetProperty("paintBuildingGuid", out _)) return null;
        try { var state = PaintState(MoveBuilding(target, R.Arg(args, "paintBuildingGuid")), target); return new { available = true, complete = true, revision = Hash(state), state,
            note = "Actual paint fields/legacy tint, native child regions/sliders and listed preservation fields. No CanBePainted/GetIndoors resolver, asset loading, paint constructor, slider setter or callback invoked by this query. Editing is immediate; closing does not undo it." }; }
        catch (PreconditionRejectedException e) { return new { available = false, complete = false, reason = e.Message }; }
    }
    internal sealed class PaintAttempt
    {
        public string Operation = "", Save = "", Day = "", BuilderLocation = "", Protection = "", InventoryDigest = "", PaintRevision = "", Channel = "";
        public CarpenterMenu Root = null!; public BuildingPaintMenu? Menu; public Building Building = null!; public GameLocation Target = null!;
        public Structure[] Buildings = Array.Empty<Structure>(); public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public PaintColors BeforeColors = null!, ExpectedColors = null!; public object Before = null!, PaletteBefore = null!;
        public uint Tint; public int Gold, Health, Region, Value, StableTicks; public float Energy;
        public bool Submitted, Released; public object? Slider; public Point Pointer, DragPointer;
    }
    private static JsonElement PaintArgs(Building b, GameLocation target) => JsonSerializer.SerializeToElement(new { locationId = target.NameOrUniqueName, paintBuildingGuid = Fact(b).BuildingGuid });
    internal static PaintAttempt PreparePaint(JsonElement args)
    {
        InventoryActions.Require(WorldReady() && Game1.player.Items.Count <= 256 && RootMenu() is not null, "Use the actual native carpenter/paint menu");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] { "operation", "locationId", "buildingGuid", "position", "menuKey", "revision", "paintRevision", "preservationDigest", "structureDigest", "inventoryDigest", "expectedGold", "regionId", "channel", "value", "allowTintReset" }.Contains(p.Name)), "Unknown native paint argument");
        var root = RootMenu()!; var target = Target(R.Arg(args, "locationId")); var b = MoveBuilding(target, R.Arg(args, "buildingGuid")); var p = PaintMenu(b);
        InventoryActions.Require(root.onFarm && Convert.ToInt32(root.Action) == 3 && !root.freeze && !root.readOnly && root.buildingToMove is null && !b.isMoving
            && ReferenceEquals(root.TargetLocation, target) && ReferenceEquals(Game1.currentLocation, target) && !Game1.eventUp && !Game1.IsFading() && R.Get(typeof(Game1), "currentMinigame") is null
            && (R.Arg(args, "operation") == "done" || b.daysOfConstructionLeft.Value == 0 && b.daysUntilUpgrade.Value == 0)
            && MineActions.Key(root) == R.Arg(args, "menuKey") && Revision(target) == R.Arg(args, "revision"), "Native paint world/menu/target/revision changed");
        InventoryActions.Require(args.TryGetProperty("position", out var pos) && R.Arg(pos, "locationId") == target.NameOrUniqueName
            && R.Int(pos, "x", -1, 0, 10000) == b.tileX.Value && R.Int(pos, "y", -1, 0, 10000) == b.tileY.Value, "Bind the exact original building tile");
        var a = new PaintAttempt { Operation = R.Arg(args, "operation"), Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), BuilderLocation = root.BuilderLocationName,
            Root = root, Menu = p, Target = target, Building = b, BeforeColors = Colors(b), Tint = b.color.PackedValue, Protection = PaintProtection(b, target),
            Buildings = Structures(target), Inventory = InventoryActions.Counts(), InventoryDigest = InventoryActions.Digest(),
            Gold = Game1.player.Money, Health = Game1.player.health, Energy = Game1.player.Stamina, PaintRevision = Hash(PaintState(b, target)) };
        InventoryActions.Require(new[] { "open", "next", "previous", "default", "slider", "done" }.Contains(a.Operation), "Unknown native paint operation");
        InventoryActions.Require(a.Operation == "done" || Game1.timeOfDay < 2200 && a.Health >= 20 && a.Energy >= 30, "Only closing the actual paint child is allowed at day/resource limits");
        InventoryActions.Require(a.PaintRevision == R.Arg(args, "paintRevision") && a.Protection == R.Arg(args, "preservationDigest") && Hash(a.Buildings) == R.Arg(args, "structureDigest")
            && a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.Gold == R.Int(args, "expectedGold", -1, 0, int.MaxValue), "Paint/protected fields/buildings/inventory/gold changed");
        a.ExpectedColors = a.BeforeColors;
        if (a.Operation == "open") {
            InventoryActions.Require(Menu() == root && (b.color == Color.White || args.TryGetProperty("allowTintReset", out var flag) && flag.ValueKind == JsonValueKind.True), "Native opening resets legacy tint to white; explicit permission is required");
            a.Pointer = PlacementPointer(root, b.tileX.Value, b.tileY.Value);
        } else {
            InventoryActions.Require(p is not null && p.activeSlider is null && p.currentPaintRegion is >= 0 and <= 2, "Use the exact native paint child with no existing drag");
            a.Region = p!.currentPaintRegion; a.PaletteBefore = Palette();
            var entries = R.Items(R.Get(p, "regions")).Take(4).ToArray();
            InventoryActions.Require(entries.Length is > 0 and <= 3 && a.Region < entries.Length && R.Text(entries[a.Region], "Id") == R.Arg(args, "regionId"), "Actual paint region changed");
            if (a.Operation == "slider") {
                a.Channel = R.Arg(args, "channel"); var s = SliderFact(p, a.Channel); a.Value = R.Int(args, "value", int.MinValue, s.Min, s.Max);
                InventoryActions.Require(a.Value != s.Value, "Skip unchanged native slider values; activation requires an explicit different value");
                a.Slider = ActualSlider(p, a.Channel); a.DragPointer = PaintSliderPointer(s, a.Value);
                a.Pointer = new Point(Math.Clamp(a.DragPointer.X, s.Bounds.Left, s.Bounds.Right - 1), s.Bounds.Center.Y);
                var values = new[] { "hue", "saturation", "lightness" }.ToDictionary(c => c, c => c == a.Channel ? a.Value : SliderFact(p, c).Value);
                var rows = a.BeforeColors.Regions.ToArray(); rows[a.Region] = new PaintRegion(a.Region, false, values["hue"], values["saturation"], values["lightness"]);
                a.ExpectedColors = a.BeforeColors with { Regions = rows };
            } else {
                var button = a.Operation switch { "next" => p.nextRegionButton, "previous" => p.previousRegionButton, "default" => p.defaultColorButton, _ => p.okButton };
                InventoryActions.Require(button?.visible == true, "Actual paint control is unavailable"); a.Pointer = button!.bounds.Center;
                if (a.Operation == "default") { var rows = a.BeforeColors.Regions.ToArray(); rows[a.Region] = rows[a.Region] with { Default = true }; a.ExpectedColors = a.BeforeColors with { Regions = rows }; }
                if (a.Operation is "next" or "previous") a.Region = (a.Region + (a.Operation == "next" ? 1 : entries.Length - 1)) % entries.Length;
            }
        }
        InventoryActions.Require(OnPaintScreen(a.Pointer) && (a.Operation != "slider" || OnPaintScreen(a.DragPointer)), "Native paint target is off screen");
        a.Before = Query(PaintArgs(b, target)); return a;
    }
    private static bool OnPaintScreen(Point p) => new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p);
    private static int PaintPixelValue(Slider s, int x)
    {
        float position = Math.Clamp((float)(x - s.Bounds.Left) / s.Bounds.Width, 0f, 1f); var range = s.Max - s.Min;
        position /= range; position *= range; return s.Min + (int)(position * range);
    }
    private static Point PaintSliderPointer(Slider s, int value)
    {
        // Match the actual single-precision truncation in SetValueFromPosition.
        // Endpoints need a native drag past the exclusive click rectangle.
        for (var x = s.Bounds.Left - 1; x <= s.Bounds.Right + 1; x++) {
            if (PaintPixelValue(s, x) == value && OnPaintScreen(new Point(x, s.Bounds.Center.Y))) return new Point(x, s.Bounds.Center.Y);
        }
        throw new PreconditionRejectedException("Requested integer paint value is not reachable with the actual slider geometry; no nearest-value guess");
    }
    internal static bool PaintContext(PaintAttempt a) => WorldReady() && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day
        && ReferenceEquals(RootMenu(), a.Root) && ReferenceEquals(a.Root.TargetLocation, a.Target) && ReferenceEquals(Game1.currentLocation, a.Target)
        && a.Root.onFarm && Convert.ToInt32(a.Root.Action) == 3 && !a.Root.freeze && !Game1.IsFading();
    internal static bool BeforePaintInput(PaintAttempt a) => PaintContext(a) && Hash(PaintState(a.Building, a.Target)) == a.PaintRevision
        && Hash(Structures(a.Target)) == Hash(a.Buildings) && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy;
    internal static bool PaintPointerReady(PaintAttempt a) => a.Operation != "open"
        || (Game1.getMouseX(false) + Game1.viewport.X) / 64 == a.Building.tileX.Value && (Game1.getMouseY(false) + Game1.viewport.Y) / 64 == a.Building.tileY.Value
            && (Game1.getOldMouseX(false) + Game1.viewport.X) / 64 == a.Building.tileX.Value && (Game1.getOldMouseY(false) + Game1.viewport.Y) / 64 == a.Building.tileY.Value;
    internal static void ExecutePaint(PaintAttempt a)
    {
        InventoryActions.Require(BeforePaintInput(a), "Native paint state changed before input"); a.Submitted = true;
        if (a.Operation == "open") a.Root.receiveLeftClick(a.Pointer.X, a.Pointer.Y, true);
        else a.Menu!.receiveLeftClick(a.Pointer.X, a.Pointer.Y, true);
    }
    internal static void ReleasePaint(PaintAttempt a)
    {
        if (a.Operation != "slider" || !a.Submitted || a.Released || !Context.IsWorldReady || !ReferenceEquals(PaintMenu(a.Building), a.Menu)
            || !ReferenceEquals(a.Menu!.activeSlider, a.Slider)) return;
        a.Menu.releaseLeftClick(Game1.getMouseX(true), Game1.getMouseY(true)); a.Released = true;
    }
    internal static bool PaintSettled(PaintAttempt a)
    {
        if (!PaintContext(a)) return false;
        // The inspected paint branch is synchronous: no child after the real
        // handler is a known refusal, not an outstanding construction lock.
        if (a.Operation == "open") return a.Root.GetChildMenu() is null || a.Root.GetChildMenu()?.GetType() == typeof(BuildingPaintMenu) || a.Root.GetChildMenu()?.GetType() == typeof(BuildingSkinMenu);
        if (a.Operation == "done") return a.Root.GetChildMenu() is null;
        return ReferenceEquals(PaintMenu(a.Building), a.Menu) && a.Menu!.activeSlider is null && a.Menu.currentPaintRegion == a.Region && (a.Operation != "slider" || a.Released);
    }
    internal static object FinishPaint(PaintAttempt a)
    {
        var openRejected = a.Operation == "open" && a.Root.GetChildMenu() is null;
        var tint = a.Operation == "open" && !openRejected ? Color.White.PackedValue : a.Tint; var after = Colors(a.Building);
        var otherColorsBefore = JsonSerializer.SerializeToElement(a.Before, LocalServer.Json).GetProperty("paint").GetProperty("state").GetProperty("colorRoster");
        var actualOther = JsonSerializer.SerializeToElement(ColorRoster(a.Target), LocalServer.Json);
        var guid = Fact(a.Building).BuildingGuid;
        string Other(JsonElement rows) => Hash(rows.EnumerateArray().Where(row => row.GetProperty("guid").GetString() != guid).ToArray());
        var changes = InventoryActions.Changes(a.Inventory);
        var confirmed = PaintSettled(a) && Hash(after) == Hash(a.ExpectedColors) && a.Building.color.PackedValue == tint && Hash(Structures(a.Target)) == Hash(a.Buildings)
            && Other(otherColorsBefore) == Other(actualOther) && PaintProtection(a.Building, a.Target) == a.Protection
            && InventoryActions.Digest() == a.InventoryDigest && changes.Length == 0 && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy
            && (a.Operation == "open" || Hash(Palette()) == Hash(a.PaletteBefore));
        return new { confirmedEffect = confirmed, completedWorkflow = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Submitted,
            operation = a.Operation, buildingGuid = guid, colorsBefore = a.BeforeColors, colorsAfter = after, tintBefore = a.Tint, tintAfter = a.Building.color.PackedValue,
            paintOpened = PaintMenu(a.Building) is not null, openRejected, preservationVerified = confirmed, paletteUnchanged = a.Operation == "open" ? (bool?)null : Hash(Palette()) == Hash(a.PaletteBefore),
            inventoryChanges = changes, goldBefore = a.Gold, goldAfter = Game1.player.Money, before = a.Before, after = Query(PaintArgs(a.Building, a.Target)),
            note = "Native UI edits apply immediately. Done only closes; no rollback/cancel promise. Native opening may reset approved legacy tint. No color/net field writes, slider setter, private callback invocation, palette save/copy, skin change or replay." };
    }
}
