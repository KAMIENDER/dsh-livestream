using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Menus;

namespace DshStardew;

/// <summary>Actual carpenter offers, native UI construction/upgrade and observable receipts.</summary>
internal static partial class ConstructionActions
{
    private static bool Supported() => typeof(Game1).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    private static string Hash(object value) => GameFacts.Hash(JsonSerializer.Serialize(value, LocalServer.Json));
    private static CarpenterMenu? RootMenu() => Game1.activeClickableMenu?.GetType() == typeof(CarpenterMenu) ? (CarpenterMenu)Game1.activeClickableMenu : null;
    private static CarpenterMenu? Menu() => RootMenu() is { } m && m.GetChildMenu() is null ? m : null;
    private static bool WorldReady() => Supported() && Context.IsWorldReady && Context.IsMainPlayer && !Context.IsMultiplayer;
    internal sealed record Material(string ItemId, int Amount);
    internal sealed record Limit(string ItemId, int Quality, int MaxCount);
    internal sealed record Structure(string BuildingGuid, string BuildingKey, string Type, string NativeType, bool Native,
        string? SkinId, string? UpgradeName, int X, int Y, int Width, int Height, int ConstructionDays, int UpgradeDays, string Owner, bool IsMoving);
    private static string? TextOrNull(object? value) => value is null ? null : value as string ?? throw new InvalidOperationException("Unknown construction text field");
    private static object Entry(object b) => new { blueprintKey = MineActions.Key(b), index = R.Get(b, "Index"), id = R.Get(b, "Id"),
        skinId = R.Get(R.Get(b, "Skin"), "Id"), cost = R.Get(b, "BuildCost"), days = R.Get(b, "BuildDays"),
        width = R.Get(b, "TilesWide"), height = R.Get(b, "TilesHigh"), upgrade = R.Get(b, "IsUpgrade"), upgradeFrom = R.Get(b, "UpgradeFrom"),
        magical = R.Get(b, "MagicalConstruction") };
    private static Material[] Materials(CarpenterMenu m)
    {
        InventoryActions.Require(m.ingredients.Count <= 128 && m.ingredients.All(i => i is StardewValley.Object o && o.GetType() == typeof(StardewValley.Object)
            && !o.questItem.Value && o.Stack is > 0 and <= 10000), "Unknown or incomplete native building materials");
        return m.ingredients.GroupBy(i => i.QualifiedItemId).Select(g => new Material(g.Key, checked(g.Sum(i => i.Stack)))).OrderBy(r => r.ItemId, StringComparer.Ordinal).ToArray();
    }
    private static string PlanDigest(CarpenterMenu m) => Hash(new { entry = Entry(R.Get(m, "Blueprint") ?? throw new InvalidOperationException("No actual blueprint")),
        materials = Materials(m), previewKey = m.currentBuilding is null ? null : MineActions.Key(m.currentBuilding),
        previewType = m.currentBuilding?.GetType().FullName, previewSkin = m.currentBuilding?.skinId.Value });
    private static object[] Offers(CarpenterMenu m)
    {
        var entries = R.Items(R.Get(m, "Blueprints")).Take(257).ToArray();
        InventoryActions.Require(entries.Length is > 0 and <= 256 && entries.All(b => b.GetType().Assembly == typeof(Game1).Assembly
            && b.GetType().Name == "BlueprintEntry" && b.GetType().DeclaringType == typeof(CarpenterMenu)), "Unknown/incomplete actual carpenter offers");
        return entries.Select(Entry).ToArray();
    }
    private static Structure Fact(Building b)
    {
        var id = R.Get(b, "id"); InventoryActions.Require(id is Guid guid && guid != Guid.Empty, "Building has no persistent native identity");
        return new(((Guid)id!).ToString("D"), MineActions.Key(b), b.buildingType.Value, b.GetType().FullName!, b.GetType().Assembly == typeof(Game1).Assembly,
            b.skinId.Value, TextOrNull(R.Get(b, "upgradeName")), b.tileX.Value, b.tileY.Value, b.tilesWide.Value, b.tilesHigh.Value,
            b.daysOfConstructionLeft.Value, b.daysUntilUpgrade.Value, b.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), b.isMoving);
    }
    internal static Structure[] Structures(GameLocation location)
    {
        var buildings = R.Items(R.Get(location, "buildings")).Take(257).ToArray();
        InventoryActions.Require(buildings.Length <= 256 && buildings.All(b => b is Building), "Incomplete native building roster");
        var rows = buildings.Cast<Building>().Select(Fact).OrderBy(b => b.BuildingGuid, StringComparer.Ordinal).ToArray();
        InventoryActions.Require(rows.All(b => b.Native && b.Width is > 0 and <= 128 && b.Height is > 0 and <= 128 && b.ConstructionDays is >= 0 and <= 10000 && b.UpgradeDays is >= 0 and <= 10000)
            && rows.Select(b => b.BuildingGuid).Distinct(StringComparer.Ordinal).Count() == rows.Length, "Unknown, duplicate or unbounded native buildings"); return rows;
    }
    private static GameLocation Target(string id)
    {
        // Only already loaded roots or the game's actual carpenter target; do
        // not load/create a location or construct a preview building in a query.
        var locations = Game1.locations.Take(513).Concat(new[] { Game1.currentLocation }).Concat((RootMenu() ?? DemolitionQuestionRoot())?.TargetLocation is { } t ? new[] { t } : Array.Empty<GameLocation>()).Distinct().ToArray();
        InventoryActions.Require(locations.Length <= 515, "Loaded location capture exceeds its bound");
        var found = locations.Where(l => l.NameOrUniqueName == id).ToArray();
        InventoryActions.Require(found.Length == 1, "Use one actual loaded construction location"); return found[0];
    }
    private static object ActorPosition() => new { locationId = Game1.player.currentLocation.NameOrUniqueName, x = (int)Game1.player.Tile.X, y = (int)Game1.player.Tile.Y };
    private static string Revision(GameLocation target) => Hash(new { save = GameFacts.SaveId(), day = GameFacts.DayKey(), state = MineActions.State(),
        actorPosition = ActorPosition(), viewingLocation = R.Get(Game1.player, "viewingLocation"),
        targetKey = MineActions.Key(target), structures = Structures(target),
        menu = (RootMenu() ?? DemolitionQuestionRoot()) is { } m ? new { menuKey = MineActions.Key(m), active = ReferenceEquals(m, Game1.activeClickableMenu), m.Builder, m.BuilderLocationName, target = MineActions.Key(m.TargetLocation),
            childKey = m.GetChildMenu() is { } child ? MineActions.Key(child) : null,
            m.onFarm, action = Convert.ToInt32(m.Action), m.freeze, m.readOnly, plan = PlanDigest(m),
            movingBuildingKey = m.buildingToMove is null ? null : MineActions.Key(m.buildingToMove),
            controls = new[] { m.backButton, m.forwardButton, m.okButton, m.cancelButton, m.moveButton, m.paintButton }.Select(c => c is null ? null : new { c.visible, bounds = R.Plain(c.bounds) }).ToArray() } : null,
        viewport = new { Game1.viewport.X, Game1.viewport.Y, Game1.viewport.Width, Game1.viewport.Height, uiWidth = Game1.uiViewport.Width, uiHeight = Game1.uiViewport.Height, Game1.options.zoomLevel, Game1.options.uiScale },
        fading = Game1.IsFading() });
    public static object Query(JsonElement args)
    {
        if (!WorldReady() || Game1.player.Items.Count > 256) return new { available = false, reason = "unsupported_construction_world_build_or_inventory_bound" };
        var m = RootMenu() ?? DemolitionQuestionRoot(); var id = R.Arg(args, "locationId", m?.TargetLocation?.NameOrUniqueName ?? Game1.currentLocation.NameOrUniqueName); var target = Target(id);
        var structures = Structures(target); var layer = target.Map.Layers[0];
        return new { available = true, complete = true, revision = Revision(target), state = MineActions.State(),
            actorPosition = ActorPosition(), viewingLocation = R.Get(Game1.player, "viewingLocation"),
            entry = QueryEntry(args), move = QueryMove(args, target), paint = QueryPaint(args, target), skin = QuerySkin(args, target), demolition = QueryDemolition(args, target),
            target = new { locationId = target.NameOrUniqueName, locationKey = MineActions.Key(target), width = layer.LayerWidth, height = layer.LayerHeight },
            structures, structureDigest = Hash(structures),
            menu = m is null ? null : new { menuKey = MineActions.Key(m), active = ReferenceEquals(m, Game1.activeClickableMenu), builder = m.Builder, builderLocationId = m.BuilderLocationName,
                targetLocationId = m.TargetLocation.NameOrUniqueName, targetLocationKey = MineActions.Key(m.TargetLocation), m.onFarm,
                action = Convert.ToInt32(m.Action), m.freeze, m.readOnly, fading = Game1.IsFading(),
                selected = Entry(R.Get(m, "Blueprint")!), planDigest = PlanDigest(m), materials = Materials(m), offers = Offers(m),
                childType = m.GetChildMenu()?.GetType().FullName, childKey = m.GetChildMenu() is { } c ? MineActions.Key(c) : null,
                cancelBounds = R.Plain(m.cancelButton?.bounds), moveBounds = R.Plain(m.moveButton?.bounds), moveVisible = m.moveButton?.visible == true,
                paintVisible = m.paintButton?.visible == true,
                movingBuildingGuid = m.buildingToMove is null ? null : Fact(m.buildingToMove).BuildingGuid,
                movingBuildingKey = m.buildingToMove is null ? null : MineActions.Key(m.buildingToMove),
                previewNative = m.currentBuilding?.GetType().Assembly == typeof(Game1).Assembly, previewSkinId = m.currentBuilding?.skinId.Value },
            viewport = new { Game1.viewport.X, Game1.viewport.Y, Game1.viewport.Width, Game1.viewport.Height, uiWidth = Game1.uiViewport.Width, uiHeight = Game1.uiViewport.Height, Game1.options.zoomLevel, Game1.options.uiScale },
            note = "Actual native carpenter menu/offers, loaded buildings, inspected native counter/book and construction selector state. No constructor, condition RNG, resource consumption, build/upgrade/finish or location loading in this query. Persistent buildingGuid survives reload; menu/blueprint/buildingKey do not. Construction start is not completed construction." };
    }

    internal sealed class Attempt
    {
        public string Operation = "", Save = "", Day = "", BuilderLocation = "", Plan = "", InventoryDigest = "", TargetDigest = "";
        public CarpenterMenu Menu = null!;
        public GameLocation Target = null!;
        public object Blueprint = null!, Before = null!;
        public Structure[] Buildings = Array.Empty<Structure>();
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public Material[] Materials = Array.Empty<Material>();
        public Limit[] Limits = Array.Empty<Limit>();
        public int Gold, Health, Cost, Days, X, Y, StableTicks, InitialIndex, InitialAction, OfferCount, PanPixels, PanIdleTicks;
        public float Energy;
        public string Id = "", Direction = "";
        public string? PreviewSkinId, UpgradeGuid, UpgradeFrom;
        public bool Upgrade, Submitted, InitialOnFarm, PanEnded;
        public Point PanStart, LastPan;
        public Point? Pointer;
    }
    internal static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(WorldReady() && Menu() is not null && Game1.player.Items.Count <= 256,
            "Use the actual open native carpenter menu and bounded inventory");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] { "operation", "locationId", "revision", "menuKey", "blueprintKey", "planDigest", "structureDigest", "inventoryDigest", "expectedGold", "position", "buildingGuid", "maxGold", "materialBudget", "direction", "panPixels" }.Contains(p.Name)), "Unknown construction argument");
        var menu = Menu()!; var target = Target(R.Arg(args, "locationId")); var blueprint = R.Get(menu, "Blueprint")!;
        InventoryActions.Require(!menu.readOnly && !menu.freeze && !Game1.IsFading() && !Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null
            && ReferenceEquals(menu.TargetLocation, target) && menu.currentBuilding?.GetType().Assembly == typeof(Game1).Assembly
            && MineActions.Key(menu) == R.Arg(args, "menuKey") && MineActions.Key(blueprint) == R.Arg(args, "blueprintKey")
            && PlanDigest(menu) == R.Arg(args, "planDigest") && Revision(target) == R.Arg(args, "revision"), "Actual carpenter menu, target, blueprint or revision changed");
        var operation = R.Arg(args, "operation"); InventoryActions.Require(new[] { "next", "previous", "enter_placement", "enter_paint", "commit", "cancel", "close", "pan" }.Contains(operation), "Unknown native construction operation");
        InventoryActions.Require(operation is "cancel" or "close" || Game1.timeOfDay < 2200 && Game1.player.health >= 20 && Game1.player.Stamina >= 30,
            "Only native cancellation/close is allowed at day/resource limits");
        var a = new Attempt { Operation = operation, Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), Menu = menu, Target = target,
            BuilderLocation = menu.BuilderLocationName, Blueprint = blueprint, Plan = PlanDigest(menu), Buildings = Structures(target), Inventory = InventoryActions.Counts(),
            InventoryDigest = InventoryActions.Digest(), Materials = Materials(menu), Gold = Game1.player.Money, Health = Game1.player.health, Energy = Game1.player.Stamina,
            Id = R.Text(blueprint, "Id"), PreviewSkinId = menu.currentBuilding?.skinId.Value, Upgrade = R.Bool(blueprint, "IsUpgrade"),
            UpgradeFrom = TextOrNull(R.Get(blueprint, "UpgradeFrom")), Cost = checked((int)R.Number(blueprint, "BuildCost")), Days = checked((int)R.Number(blueprint, "BuildDays")),
            InitialIndex = checked((int)R.Number(blueprint, "Index")), InitialAction = Convert.ToInt32(menu.Action), InitialOnFarm = menu.onFarm,
            OfferCount = Offers(menu).Length, PanStart = new Point(Game1.viewport.X, Game1.viewport.Y), LastPan = new Point(Game1.viewport.X, Game1.viewport.Y) };
        a.TargetDigest = Hash(a.Buildings);
        InventoryActions.Require(a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.TargetDigest == R.Arg(args, "structureDigest")
            && a.Gold == R.Int(args, "expectedGold", -1, 0, int.MaxValue), "Actual inventory, buildings or gold changed");
        if (operation is "commit" or "enter_placement") InventoryActions.Require(a.Cost is >= 0 and <= 1000000000 && a.Days is >= 0 and <= 10000, "Unbounded/unknown native construction price or duration");
        if (operation is "next" or "previous" or "enter_placement" or "enter_paint" or "close") InventoryActions.Require(!menu.onFarm && Convert.ToInt32(menu.Action) == 0
            && Game1.currentLocation.NameOrUniqueName == a.BuilderLocation, "Use the actual builder catalogue, not a different placement action/location");
        if (operation is "commit" or "pan" or "cancel") InventoryActions.Require(menu.onFarm && (Convert.ToInt32(menu.Action) == (a.Upgrade ? 4 : 0)
            || (operation is "pan" or "cancel") && Convert.ToInt32(menu.Action) == 3)
            && menu.buildingToMove is null && ReferenceEquals(Game1.currentLocation, target), "Actual build/upgrade placement mode changed");
        if (operation == "commit")
        {
            InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == target.NameOrUniqueName, "Use the exact approved target location and tile");
            a.X = R.Int(p, "x", -1, 0, target.Map.Layers[0].LayerWidth - 1); a.Y = R.Int(p, "y", -1, 0, target.Map.Layers[0].LayerHeight - 1);
            if (a.Upgrade)
            {
                a.UpgradeGuid = R.Arg(args, "buildingGuid"); var b = a.Buildings.SingleOrDefault(b => b.BuildingGuid == a.UpgradeGuid);
                InventoryActions.Require(b is not null && b.Type == a.UpgradeFrom && b.ConstructionDays == 0 && b.UpgradeDays == 0
                    && a.X >= b.X && a.Y >= b.Y && a.X < b.X + b.Width && a.Y < b.Y + b.Height, "Use the exact idle native building eligible for this upgrade");
            }
            else InventoryActions.Require(!args.TryGetProperty("buildingGuid", out _) && !a.Buildings.Any(b => new Rectangle(b.X, b.Y, b.Width, b.Height)
                .Intersects(new Rectangle(a.X, a.Y, menu.currentBuilding.tilesWide.Value, menu.currentBuilding.tilesHigh.Value))), "New construction must not replace an existing building");
            InventoryActions.Require(a.Cost <= R.Int(args, "maxGold", -1, 0, 1000000000) && a.Gold >= a.Cost, "Construction exceeds the exact gold budget");
            a.Limits = ParseLimits(args); CheckMaterials(a);
        }
        if (operation == "pan") { a.Direction = R.Arg(args, "direction"); InventoryActions.Require(new[] { "up", "down", "left", "right" }.Contains(a.Direction), "Use an explicit camera direction"); a.PanPixels = R.Int(args, "panPixels", 128, 8, 512); }
        a.Before = Query(JsonSerializer.SerializeToElement(new { locationId = target.NameOrUniqueName })); return a;
    }
    private static Limit[] ParseLimits(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("materialBudget", out var rows) && rows.ValueKind == JsonValueKind.Array && rows.GetArrayLength() <= 128, "Provide explicit per-item/quality material budgets, including an empty array for free construction");
        var limits = rows.EnumerateArray().Select(row => { InventoryActions.Require(row.ValueKind == JsonValueKind.Object && row.EnumerateObject().All(p => new[] { "itemId", "quality", "maxCount" }.Contains(p.Name)), "Unknown material budget");
            var id = R.Arg(row, "itemId"); InventoryActions.Require(id.StartsWith("(O)", StringComparison.Ordinal) && id.Length <= 160, "Use an actual full object ID from the menu materials");
            return new Limit(id, R.Int(row, "quality", -1, 0, 4), R.Int(row, "maxCount", -1, 1, 10000)); }).ToArray();
        InventoryActions.Require(limits.Select(l => (l.ItemId, l.Quality)).Distinct().Count() == limits.Length, "Duplicate material budgets"); return limits;
    }
    private static void CheckMaterials(Attempt a)
    {
        // ReduceId consumes its existing native item index, whose order is not
        // a bag-slot order contract. Authorize the worst possible allocation of
        // each actual quality before input; never pretend to predict its order.
        foreach (var material in a.Materials)
        {
            var sources = Game1.player.Items.Where(i => i?.QualifiedItemId == material.ItemId).ToArray();
            InventoryActions.Require(sources.All(i => i?.GetType() == typeof(StardewValley.Object) && i is StardewValley.Object o && !o.questItem.Value && o.Stack is > 0 and <= 10000)
                && sources.Sum(i => (long)i.Stack) >= material.Amount, "Native building materials are insufficient, special/custom or quest-owned");
            foreach (var group in sources.GroupBy(i => i.Quality)) InventoryActions.Require(a.Limits.Any(l => l.ItemId == material.ItemId && l.Quality == group.Key
                && l.MaxCount >= Math.Min(material.Amount, group.Sum(i => i.Stack))), "Material quality budget cannot cover every possible native indexed allocation");
        }
    }
    internal static bool ContextMatches(Attempt a) => WorldReady() && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day
        && (Game1.currentLocation.NameOrUniqueName == a.BuilderLocation || ReferenceEquals(Game1.currentLocation, a.Target));
    internal static bool BeforeInput(Attempt a) => ContextMatches(a) && ReferenceEquals(Menu(), a.Menu) && !a.Menu.freeze && !Game1.IsFading()
        && a.Menu.onFarm == a.InitialOnFarm && Convert.ToInt32(a.Menu.Action) == a.InitialAction
        && ReferenceEquals(R.Get(a.Menu, "Blueprint"), a.Blueprint) && PlanDigest(a.Menu) == a.Plan && InventoryActions.Digest() == a.InventoryDigest
        && Hash(Structures(a.Target)) == a.TargetDigest && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy;
    internal static Point Pointer(Attempt a)
    {
        Point p;
        if (a.Operation == "commit")
        {
            p = PlacementPointer(a.Menu, a.X, a.Y);
        }
        else
        {
            var c = a.Operation switch { "next" => a.Menu.forwardButton, "previous" => a.Menu.backButton,
                "enter_placement" => a.Menu.okButton, "enter_paint" => a.Menu.paintButton, _ => a.Menu.cancelButton };
            InventoryActions.Require(c is not null && c.visible, "Actual carpenter component is unavailable"); p = c.bounds.Center;
        }
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p)
            && (a.Operation != "commit" || a.Menu.cancelButton?.containsPoint(p.X, p.Y) != true), "Actual carpenter target is off screen or overlaps its cancellation control"); return p;
    }
    // Shared by construction and relocation. The real handler derives its tile
    // from native world mouse coordinates, not from the requested UI pixels.
    private static Point PlacementPointer(CarpenterMenu menu, int tileX, int tileY)
    {
        var scale = Game1.options.uiScale / Game1.options.zoomLevel;
        InventoryActions.Require(float.IsFinite(scale) && scale > 0, "Native world/UI scale is unavailable");
        var x = tileX * 64 + 32 - Game1.viewport.X; var y = tileY * 64 + 32 - Game1.viewport.Y;
        InventoryActions.Require(x >= 64 && x < Game1.viewport.Width - 128 && y >= 64 && y < Game1.viewport.Height - 64, "Pan the native placement camera before clicking this tile");
        var p = new Point((int)(x / scale), (int)(y / scale));
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p)
            && menu.cancelButton?.containsPoint(p.X, p.Y) != true, "Placement tile overlaps a control or is off screen"); return p;
    }
    internal static bool PointerReady(Attempt a, Point p) => Math.Abs(Game1.getMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getMouseY(true) - p.Y) <= 2
        && Math.Abs(Game1.getOldMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getOldMouseY(true) - p.Y) <= 2
        && (a.Operation != "commit" || (Game1.getOldMouseX(false) + Game1.viewport.X) / 64 == a.X && (Game1.getOldMouseY(false) + Game1.viewport.Y) / 64 == a.Y
            && (Game1.getMouseX(false) + Game1.viewport.X) / 64 == a.X && (Game1.getMouseY(false) + Game1.viewport.Y) / 64 == a.Y);
    internal static void Execute(Attempt a, Point p)
    {
        InventoryActions.Require(BeforeInput(a), "Construction preconditions changed before input");
        if (a.Operation == "commit") CheckMaterials(a);
        a.Submitted = true; a.Pointer = p;
        // Only the real menu handler may choose the native lock/callback, build,
        // consume, upgrade, construction days and return warp. Never call those
        // helpers directly or manually edit buildings, gold, items or timers.
        a.Menu.receiveLeftClick(p.X, p.Y, true);
    }
    internal static void Pan(Attempt a)
    {
        InventoryActions.Require(BeforeInput(a) && a.Menu.onFarm, "Native pan context changed");
        var scale = Game1.options.uiScale / Game1.options.zoomLevel; InventoryActions.Require(float.IsFinite(scale) && scale > 0, "Native pan scale is unavailable");
        var x = a.Direction == "left" ? 1 : a.Direction == "right" ? Game1.viewport.Width - 1 : Game1.viewport.Width / 2;
        var y = a.Direction == "up" ? 1 : a.Direction == "down" ? Game1.viewport.Height - 1 : Game1.viewport.Height / 2;
        var p = new Point((int)(x / scale), (int)(y / scale));
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Native pan edge is unavailable");
        a.Pointer = p; a.Submitted = true; Game1.setMousePosition(p.X, p.Y, true);
        var view = new Point(Game1.viewport.X, Game1.viewport.Y); a.PanIdleTicks = view == a.LastPan ? a.PanIdleTicks + 1 : 0; a.LastPan = view;
        var distance = a.Direction switch { "left" => a.PanStart.X - view.X, "right" => view.X - a.PanStart.X, "up" => a.PanStart.Y - view.Y, _ => view.Y - a.PanStart.Y };
        if (distance >= a.PanPixels || a.PanIdleTicks >= 12) { a.PanEnded = true; StopPan(a); }
    }
    internal static void StopPan(Attempt a)
    {
        if (a.Operation is not "pan" and not "enter_placement" and not "enter_paint" || !a.Submitted || !Context.IsWorldReady || !ReferenceEquals(Menu(), a.Menu) || !a.Menu.onFarm || a.Pointer is not { } p) return;
        // Edge scrolling continues without a held key. End only our still-owned
        // cursor edge; do not move a cursor the player has already taken over.
        if (Math.Abs(Game1.getMouseX(true) - p.X) <= 3 && Math.Abs(Game1.getMouseY(true) - p.Y) <= 3)
            Game1.setMousePosition(Game1.uiViewport.Width / 2, Game1.uiViewport.Height / 2, true);
    }
    internal static bool Settled(Attempt a)
    {
        if (!ContextMatches(a) || Game1.IsFading()) return false;
        return a.Operation switch {
            "next" or "previous" => ReferenceEquals(Menu(), a.Menu) && !a.Menu.onFarm && !a.Menu.freeze
                && R.Number(R.Get(a.Menu, "Blueprint"), "Index") == (a.InitialIndex + (a.Operation == "next" ? 1 : a.OfferCount - 1)) % a.OfferCount,
            "enter_placement" => ReferenceEquals(Menu(), a.Menu) && a.Menu.onFarm && !a.Menu.freeze && ReferenceEquals(Game1.currentLocation, a.Target),
            "enter_paint" => ReferenceEquals(Menu(), a.Menu) && a.Menu.onFarm && Convert.ToInt32(a.Menu.Action) == 3 && !a.Menu.freeze && ReferenceEquals(Game1.currentLocation, a.Target),
            "cancel" => ReferenceEquals(Menu(), a.Menu) && !a.Menu.onFarm && !a.Menu.freeze && Game1.currentLocation.NameOrUniqueName == a.BuilderLocation,
            "close" => Game1.activeClickableMenu is null && Context.CanPlayerMove,
            "commit" => Game1.currentLocation.NameOrUniqueName == a.BuilderLocation
                && (Game1.activeClickableMenu?.GetType() == typeof(DialogueBox) || Game1.activeClickableMenu is null && Context.CanPlayerMove),
            "pan" => ReferenceEquals(Menu(), a.Menu) && a.Menu.onFarm && !a.Menu.freeze && a.PanEnded,
            _ => false,
        };
    }
    internal static object Finish(Attempt a)
    {
        var after = Structures(a.Target); var changes = InventoryActions.Changes(a.Inventory); var goldAfter = Game1.player.Money;
        Structure? result = null; var effect = false;
        if (a.Operation == "commit")
        {
            result = a.Upgrade ? after.SingleOrDefault(b => b.BuildingGuid == a.UpgradeGuid) : after.SingleOrDefault(b => !a.Buildings.Any(old => old.BuildingGuid == b.BuildingGuid));
            var actualCosts = changes.Where(c => c.Amount < 0).ToArray();
            var previous = a.Upgrade ? a.Buildings.Single(b => b.BuildingGuid == a.UpgradeGuid) : null;
            effect = result is not null && (a.Upgrade ? after.Length == a.Buildings.Length && result.X == previous!.X && result.Y == previous.Y
                    && (result.Type == a.Id && result.UpgradeDays == 0 || result.Type == a.UpgradeFrom && result.UpgradeName == a.Id && result.UpgradeDays == Math.Max(1, a.Days))
                : after.Length == a.Buildings.Length + 1 && result.Type == a.Id && result.SkinId == a.PreviewSkinId && result.X == a.X && result.Y == a.Y)
                && a.Buildings.Where(b => b.BuildingGuid != a.UpgradeGuid).SequenceEqual(after.Where(b => b.BuildingGuid != result.BuildingGuid))
                && a.Gold - goldAfter == a.Cost && changes.All(c => c.Amount < 0)
                && actualCosts.All(c => a.Limits.Any(l => l.ItemId == c.ItemId && l.Quality == c.Quality && -c.Amount <= l.MaxCount))
                && a.Materials.All(m => actualCosts.Where(c => c.ItemId == m.ItemId).Sum(c => -c.Amount) == m.Amount)
                && actualCosts.All(c => a.Materials.Any(m => m.ItemId == c.ItemId));
        }
        else effect = a.Buildings.SequenceEqual(after) && changes.Length == 0 && goldAfter == a.Gold;
        if (a.Operation == "pan") {
            var dx = Game1.viewport.X - a.PanStart.X; var dy = Game1.viewport.Y - a.PanStart.Y;
            effect &= a.Direction is "left" or "right" ? dy == 0 && (a.Direction == "left" ? -dx : dx) >= 0 && Math.Abs(dx) <= a.PanPixels + 16
                : dx == 0 && (a.Direction == "up" ? -dy : dy) >= 0 && Math.Abs(dy) <= a.PanPixels + 16;
        }
        var confirmed = ContextMatches(a) && a.Submitted && Settled(a) && effect && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy;
        return new { confirmedEffect = confirmed, completedWorkflow = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Submitted,
            operation = a.Operation, constructionStarted = confirmed && a.Operation == "commit", result = confirmed ? result : null,
            panDelta = new { x = Game1.viewport.X - a.PanStart.X, y = Game1.viewport.Y - a.PanStart.Y },
            constructionReady = confirmed && result is not null && result.Type == a.Id && result.ConstructionDays == 0 && result.UpgradeDays == 0,
            inventoryChanges = changes, goldBefore = a.Gold, goldAfter, before = a.Before,
            after = Query(JsonSerializer.SerializeToElement(new { locationId = a.Target.NameOrUniqueName })),
            note = "Only the native step and listed costs/state are confirmed. Started construction/upgrade is not completion; inspect this persistent buildingGuid on later days. No forced completion, refunds, rollback or replay." };
    }
}
