using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Menus;

namespace DshStardew;

internal static partial class ConstructionActions
{
    internal sealed record SkinDefinition(string Id, int? BuildDays);
    internal sealed record SkinData(int BaseBuildDays, bool CurrentDeclared, SkinDefinition[] Definitions);
    internal sealed record SkinOffer(int Index, string Key, string? Id, int? BuildDays);
    private static int? SkinDays(object? data)
    {
        var value = R.Get(data, "BuildDays"); InventoryActions.Require(value is null || value is int i && i is >= 0 and <= 10000, "Unknown or unbounded native skin build days"); return value as int?;
    }
    private static SkinData LoadedSkinData(Building b)
    {
        // buildingData is an actual loaded Game1 field in this exact build.
        // Read it directly: no GetData loader, GSQ evaluation or menu creation.
        var cache = R.Raw(typeof(Game1), "buildingData"); InventoryActions.Require(cache is not null, "Loaded building data is unavailable");
        var rows = R.Items(cache).Take(4097).ToArray(); InventoryActions.Require(rows.Length <= 4096, "Incomplete loaded building data");
        var matches = rows.Where(row => R.Raw(row, "Key") is string id && id == b.buildingType.Value).ToArray();
        InventoryActions.Require(matches.Length == 1, "No unique actual building data"); var data = R.Get(matches[0], "Value")!;
        var baseDays = SkinDays(data); InventoryActions.Require(baseDays is not null, "No actual base building duration");
        var skins = R.Items(R.Get(data, "Skins")).Take(257).ToArray(); InventoryActions.Require(skins.Length <= 256, "Incomplete declared skin data");
        var definitions = skins.Select(s => { var id = R.Get(s, "Id") as string; InventoryActions.Require(!string.IsNullOrEmpty(id) && id.Length <= 160, "Unknown declared skin ID"); return new SkinDefinition(id!, SkinDays(s)); }).ToArray();
        InventoryActions.Require(definitions.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() == definitions.Length, "Duplicate declared skin IDs");
        return new(baseDays!.Value, b.skinId.Value is null || definitions.Any(d => d.Id == b.skinId.Value), definitions);
    }
    private static BuildingPaintMenu? SkinPaintParent(Building b) => RootMenu()?.GetChildMenu() is BuildingPaintMenu p && p.GetType() == typeof(BuildingPaintMenu)
        && ReferenceEquals(p.building, b) && ReferenceEquals(p.colorTarget, R.Get(b, "netBuildingPaintColor")) ? p : null;
    private static BuildingSkinMenu? SkinMenu(Building b)
    {
        var child = RootMenu()?.GetChildMenu(); if (child is BuildingPaintMenu) child = SkinPaintParent(b)?.GetChildMenu();
        return child?.GetType() == typeof(BuildingSkinMenu) && child.GetChildMenu() is null && ReferenceEquals(((BuildingSkinMenu)child).Building, b) ? (BuildingSkinMenu)child : null;
    }
    private static SkinOffer[] SkinOffers(BuildingSkinMenu m)
    {
        var rows = R.Items(m.Skins).Take(257).ToArray();
        InventoryActions.Require(rows.Length is > 0 and <= 256 && rows.All(e => e.GetType().DeclaringType == typeof(BuildingSkinMenu) && e.GetType().Name == "SkinEntry"), "Unknown/incomplete actual skin offers");
        var offers = rows.Select(e => new SkinOffer(checked((int)R.Number(e, "Index")), MineActions.Key(e), TextOrNull(R.Get(e, "Id")), SkinDays(R.Get(e, "Data")))).ToArray();
        InventoryActions.Require(offers.Select((e, i) => e.Index == i && (e.Id is null || e.Id.Length is > 0 and <= 160)).All(v => v)
            && offers.Select(e => e.Id).Distinct(StringComparer.Ordinal).Count() == offers.Length, "Invalid/duplicate actual skin entries"); return offers;
    }
    private static object SkinState(Building b, GameLocation target)
    {
        var m = SkinMenu(b); var parent = SkinPaintParent(b); var data = LoadedSkinData(b);
        return new { worldRevision = Revision(target), building = Fact(b), colors = Colors(b), legacyTint = b.color.PackedValue, data,
            preservationDigest = PaintProtection(b, target), colorRoster = ColorRoster(target),
            rootKey = RootMenu() is { } root ? MineActions.Key(root) : null, childType = RootMenu()?.GetChildMenu()?.GetType().FullName,
            paintParentKey = parent is null ? null : MineActions.Key(parent), paintParentIdle = parent is null || parent.activeSlider is null,
            paletteDigest = parent is null ? null : Hash(Palette()),
            menu = m is null ? null : new { key = MineActions.Key(m), depth = parent is null ? 1 : 2, offers = SkinOffers(m),
                selectedKey = m.Skin is null ? null : MineActions.Key(m.Skin),
                controls = new[] { m.PreviousSkinButton, m.NextSkinButton, m.OkButton }.Select(c => c is null ? null : new { c.visible, bounds = R.Plain(c.bounds) }).ToArray() } };
    }
    private static object? QuerySkin(JsonElement args, GameLocation target)
    {
        if (!args.TryGetProperty("skinBuildingGuid", out _)) return null;
        try { var state = SkinState(MoveBuilding(target, R.Arg(args, "skinBuildingGuid")), target); return new { available = true, complete = true, revision = Hash(state), state,
            note = "Declared loaded skin IDs/durations are not eligible offers. Only an actual native skin menu supplies the filtered complete offers. Query does not create menus, parse token text, evaluate conditions/RNG, call setters or load assets. Cycling immediately changes the skin and resets all three Default flags; native construction days can also change. Done does not undo selection." }; }
        catch (PreconditionRejectedException e) { return new { available = false, complete = false, reason = e.Message }; }
    }
    internal sealed class SkinAttempt
    {
        public string Operation = "", Save = "", Day = "", Revision = "", Protection = "", InventoryDigest = "";
        public CarpenterMenu Root = null!; public BuildingSkinMenu? Menu; public BuildingPaintMenu? Parent;
        public Building Building = null!; public GameLocation Target = null!; public Structure[] Buildings = Array.Empty<Structure>();
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>(); public Structure Expected = null!;
        public PaintColors ExpectedColors = null!; public object Before = null!, OtherColors = null!; public object? PaletteBefore;
        public string? ExpectedEntryKey; public uint ExpectedTint; public int Gold, Health, StableTicks; public float Energy;
        public bool Submitted, WorldClick; public Point Pointer;
    }
    private static JsonElement SkinArgs(Building b, GameLocation target) => JsonSerializer.SerializeToElement(new { locationId = target.NameOrUniqueName, skinBuildingGuid = Fact(b).BuildingGuid });
    private static string? SkinIdArg(JsonElement args, string name)
    {
        InventoryActions.Require(args.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.Null || v.ValueKind == JsonValueKind.String && v.GetString()!.Length is > 0 and <= 160), "Provide an explicit actual skin ID or null for the native base skin"); return v.ValueKind == JsonValueKind.Null ? null : v.GetString();
    }
    private static bool SkinFlag(JsonElement args, string name) => args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    internal static SkinAttempt PrepareSkin(JsonElement args)
    {
        InventoryActions.Require(WorldReady() && Game1.player.Items.Count <= 256 && RootMenu() is not null, "Use the actual native carpenter appearance menu");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] { "operation", "locationId", "buildingGuid", "position", "menuKey", "revision", "skinRevision", "preservationDigest", "structureDigest", "inventoryDigest", "expectedGold", "expectedNextSkinId", "allowTintReset", "allowColorReset", "allowOpeningFallback", "maxConstructionDays" }.Contains(p.Name)), "Unknown skin argument");
        var root = RootMenu()!; var target = Target(R.Arg(args, "locationId")); var b = MoveBuilding(target, R.Arg(args, "buildingGuid")); var menu = SkinMenu(b); var parent = SkinPaintParent(b);
        InventoryActions.Require(root.onFarm && Convert.ToInt32(root.Action) == 3 && !root.freeze && !root.readOnly && root.buildingToMove is null && !b.isMoving
            && ReferenceEquals(root.TargetLocation, target) && ReferenceEquals(Game1.currentLocation, target) && !Game1.IsFading() && !Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null
            && MineActions.Key(root) == R.Arg(args, "menuKey") && Revision(target) == R.Arg(args, "revision"), "Native appearance world/menu/revision changed");
        InventoryActions.Require(args.TryGetProperty("position", out var pos) && R.Arg(pos, "locationId") == target.NameOrUniqueName
            && R.Int(pos, "x", -1, 0, 10000) == b.tileX.Value && R.Int(pos, "y", -1, 0, 10000) == b.tileY.Value, "Use the exact persistent building and tile");
        foreach (var name in new[] { "allowTintReset", "allowColorReset", "allowOpeningFallback" }) InventoryActions.Require(!args.TryGetProperty(name, out var v) || v.ValueKind is JsonValueKind.True or JsonValueKind.False, "Skin permissions must be explicit booleans");
        var data = LoadedSkinData(b); var maxDays = R.Int(args, "maxConstructionDays", -1, 0, 10000);
        var a = new SkinAttempt { Operation = R.Arg(args, "operation"), Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), Root = root, Menu = menu, Parent = parent,
            Building = b, Target = target, Buildings = Structures(target), Expected = Fact(b), ExpectedColors = Colors(b), ExpectedTint = b.color.PackedValue,
            Inventory = InventoryActions.Counts(), InventoryDigest = InventoryActions.Digest(), Gold = Game1.player.Money, Health = Game1.player.health, Energy = Game1.player.Stamina,
            Revision = Hash(SkinState(b, target)), Protection = PaintProtection(b, target), OtherColors = ColorRoster(target), PaletteBefore = parent is null ? null : Palette() };
        InventoryActions.Require(new[] { "open", "next", "previous", "done" }.Contains(a.Operation), "Unknown native skin operation");
        InventoryActions.Require(a.Operation == "done" || Game1.timeOfDay < 2200 && a.Health >= 20 && a.Energy >= 30 && a.Expected.ConstructionDays <= maxDays, "Only normal skin close is allowed at day/resource/construction limits");
        InventoryActions.Require(a.Revision == R.Arg(args, "skinRevision") && a.Protection == R.Arg(args, "preservationDigest") && Hash(a.Buildings) == R.Arg(args, "structureDigest")
            && a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.Gold == R.Int(args, "expectedGold", -1, 0, int.MaxValue), "Skin/protected/building/inventory/gold snapshot changed");
        string? nextId = a.Expected.SkinId; int? selectedDays = null;
        if (a.Operation == "open") {
            InventoryActions.Require(menu is null && (Menu() == root || parent is not null && parent.GetChildMenu() is null && parent.activeSlider is null), "Use the native world appearance action or idle paint appearance button");
            InventoryActions.Require(data.CurrentDeclared || SkinFlag(args, "allowOpeningFallback"), "Opening can fall back to the native base skin; explicit permission required");
            if (!data.CurrentDeclared) nextId = null;
            a.WorldClick = parent is null;
            if (a.WorldClick) {
                InventoryActions.Require(b.color == Color.White || SkinFlag(args, "allowTintReset"), "Native opening resets legacy tint; explicit permission required");
                a.Pointer = PlacementPointer(root, b.tileX.Value, b.tileY.Value);
            } else { InventoryActions.Require(parent!.appearanceButton?.visible == true, "Actual paint appearance button unavailable"); a.Pointer = parent.appearanceButton.bounds.Center; }
        } else {
            InventoryActions.Require(menu is not null, "Use the exact observed native skin menu");
            var offers = SkinOffers(menu!); var current = offers.SingleOrDefault(e => e.Key == (menu!.Skin is null ? null : MineActions.Key(menu.Skin)));
            InventoryActions.Require(current is not null && current.Id == a.Expected.SkinId, "Actual selected skin differs from the building");
            if (a.Operation is "next" or "previous") {
                var selected = offers[(current!.Index + (a.Operation == "next" ? 1 : offers.Length - 1)) % offers.Length];
                InventoryActions.Require(selected.Id == SkinIdArg(args, "expectedNextSkinId"), "Next native skin is not the approved exact ID");
                nextId = selected.Id; selectedDays = selected.BuildDays; a.ExpectedEntryKey = selected.Key;
            }
            var button = a.Operation switch { "next" => menu!.NextSkinButton, "previous" => menu!.PreviousSkinButton, _ => menu!.OkButton };
            InventoryActions.Require(button?.visible == true, "Actual skin control unavailable"); a.Pointer = button!.bounds.Center;
        }
        if (nextId != a.Expected.SkinId) {
            InventoryActions.Require(a.ExpectedColors.Regions.All(c => c.Default) || SkinFlag(args, "allowColorReset"), "Changing native skin resets all custom color flags; explicit permission required");
            var days = a.Expected.ConstructionDays == data.BaseBuildDays ? selectedDays ?? data.BaseBuildDays : a.Expected.ConstructionDays;
            InventoryActions.Require(days <= maxDays, "Native skin change exceeds the approved construction duration");
            a.Expected = a.Expected with { SkinId = nextId, ConstructionDays = days };
            a.ExpectedColors = a.ExpectedColors with { Regions = a.ExpectedColors.Regions.Select(c => c with { Default = true }).ToArray() };
        }
        InventoryActions.Require(OnPaintScreen(a.Pointer), "Native appearance target is off screen"); a.Before = Query(SkinArgs(b, target)); return a;
    }
    internal static bool SkinContext(SkinAttempt a) => WorldReady() && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day && ReferenceEquals(RootMenu(), a.Root)
        && ReferenceEquals(a.Root.TargetLocation, a.Target) && ReferenceEquals(Game1.currentLocation, a.Target) && a.Root.onFarm && Convert.ToInt32(a.Root.Action) == 3 && !a.Root.freeze && !Game1.IsFading()
        && !Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null;
    internal static bool BeforeSkinInput(SkinAttempt a) => SkinContext(a) && Hash(SkinState(a.Building, a.Target)) == a.Revision
        && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Gold;
    internal static bool SkinPointerReady(SkinAttempt a) => !a.WorldClick || (Game1.getMouseX(false) + Game1.viewport.X) / 64 == a.Building.tileX.Value
        && (Game1.getMouseY(false) + Game1.viewport.Y) / 64 == a.Building.tileY.Value && (Game1.getOldMouseX(false) + Game1.viewport.X) / 64 == a.Building.tileX.Value
        && (Game1.getOldMouseY(false) + Game1.viewport.Y) / 64 == a.Building.tileY.Value;
    internal static void ExecuteSkin(SkinAttempt a)
    {
        InventoryActions.Require(BeforeSkinInput(a), "Appearance state changed before input"); a.Submitted = true;
        // Only the native handler selects, resets default flags, changes native
        // duration, or reconstructs/closes its parent paint menu on exit.
        if (a.Operation == "open") { if (a.WorldClick) a.Root.receiveLeftClick(a.Pointer.X, a.Pointer.Y, true); else a.Parent!.receiveLeftClick(a.Pointer.X, a.Pointer.Y, true); }
        else a.Menu!.receiveLeftClick(a.Pointer.X, a.Pointer.Y, true);
    }
    internal static bool SkinSettled(SkinAttempt a)
    {
        if (!SkinContext(a)) return false;
        if (a.Operation == "done") return SkinMenu(a.Building) is null && (a.Root.GetChildMenu() is null || SkinPaintParent(a.Building) is { } p && p.GetChildMenu() is null);
        if (a.Operation == "open") return SkinMenu(a.Building) is not null || a.WorldClick && (a.Root.GetChildMenu() is null || PaintMenu(a.Building) is not null);
        return ReferenceEquals(SkinMenu(a.Building), a.Menu) && a.Menu!.Skin is not null && MineActions.Key(a.Menu.Skin) == a.ExpectedEntryKey;
    }
    internal static object FinishSkin(SkinAttempt a)
    {
        var result = Fact(a.Building); var now = Structures(a.Target); var changes = InventoryActions.Changes(a.Inventory);
        var selected = SkinMenu(a.Building); var openAppliedSkin = a.Operation == "open" && selected is not null;
        // A world open may show paint first or reject synchronously, so the
        // skin constructor's fallback applies only when an actual skin child exists.
        var expected = a.Operation == "open" && !openAppliedSkin ? a.Buildings.Single(b => b.BuildingGuid == a.Expected.BuildingGuid) : a.Expected;
        var original = JsonSerializer.SerializeToElement(a.Before, LocalServer.Json).GetProperty("skin").GetProperty("state");
        var expectedColors = a.Operation == "open" && !openAppliedSkin ? original.GetProperty("colors") : JsonSerializer.SerializeToElement(a.ExpectedColors, LocalServer.Json);
        var expectedTint = a.WorldClick && a.Root.GetChildMenu() is not null ? Color.White.PackedValue : a.ExpectedTint;
        string Other(object rows) => Hash(JsonSerializer.SerializeToElement(rows, LocalServer.Json).EnumerateArray().Where(r => r.GetProperty("guid").GetString() != result.BuildingGuid).ToArray());
        var confirmed = SkinSettled(a) && result == expected && Hash(JsonSerializer.SerializeToElement(Colors(a.Building), LocalServer.Json)) == Hash(expectedColors)
            && a.Building.color.PackedValue == expectedTint && Hash(now.Where(b => b.BuildingGuid != result.BuildingGuid)) == Hash(a.Buildings.Where(b => b.BuildingGuid != result.BuildingGuid)) && now.Length == a.Buildings.Length
            && Other(ColorRoster(a.Target)) == Other(a.OtherColors) && PaintProtection(a.Building, a.Target) == a.Protection
            && changes.Length == 0 && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy
            && (a.PaletteBefore is null || Hash(Palette()) == Hash(a.PaletteBefore));
        return new { confirmedEffect = confirmed, completedWorkflow = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Submitted,
            operation = a.Operation, buildingGuid = result.BuildingGuid, skinOpened = selected is not null, paintOpened = PaintMenu(a.Building) is not null,
            result, preservationVerified = confirmed, paletteChecked = a.PaletteBefore is not null, paletteUnchanged = a.PaletteBefore is null ? (bool?)null : Hash(Palette()) == Hash(a.PaletteBefore),
            inventoryChanges = changes, goldBefore = a.Gold, goldAfter = Game1.player.Money, before = a.Before, after = Query(SkinArgs(a.Building, a.Target)),
            note = "Skin cycling applies immediately and can reset all Default flags/change native construction days. Done may reconstruct the parent paint menu; no rollback or direct skin/color/timer writes, condition evaluation, setter/callback invocation or replay." };
    }
}
