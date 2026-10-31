using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Menus;
using StardewValley.Objects;

namespace DshStardew;

internal static partial class ConstructionActions
{
    private static object[] MovePairs(object? collection, int cap, Func<object, object> describe)
    {
        InventoryActions.Require(collection is not null, "Relocation collection is unavailable, not known empty");
        var rows = R.Items(collection).Take(cap + 1).ToArray();
        InventoryActions.Require(rows.Length <= cap && rows.All(row => R.Raw(row, "Key") is Vector2), "Relocation object collection exceeds its bound or has unknown tile keys");
        return rows.OrderBy(row => Convert.ToString(R.Raw(row, "Key"), System.Globalization.CultureInfo.InvariantCulture), StringComparer.Ordinal)
            .Select(row => (object)new { key = R.Plain(R.Raw(row, "Key")), value = describe(R.Get(row, "Value") ?? throw new PreconditionRejectedException("Missing relocation collection value")) }).ToArray();
    }
    private static object? MoveItem(Item? item, ref int remaining, int depth = 0)
    {
        if (item is null) return null;
        InventoryActions.Require(--remaining >= 0 && depth < 8 && item.Stack is > 0 and <= 10000
            && item.GetType().Assembly == typeof(Game1).Assembly, "Unknown, cyclic or unbounded interior item state");
        object? held = item is StardewValley.Object o ? MoveItem(o.heldObject.Value, ref remaining, depth + 1) : null;
        var contents = new List<object?>();
        if (item is Chest chest) {
            InventoryActions.Require(chest.Items.Count <= 512 && chest.GlobalInventoryId is null && (chest.SpecialChestType is Chest.SpecialChestTypes.None or Chest.SpecialChestTypes.BigChest),
                "Shared, specialized or unbounded building storage needs a separate receipt");
            foreach (var child in chest.Items) contents.Add(MoveItem(child, ref remaining, depth + 1));
        }
        return new { key = MineActions.Key(item), type = item.GetType().FullName, id = item.QualifiedItemId, item.Stack, item.Quality,
            questItem = item is StardewValley.Object quest && quest.questItem.Value,
            held, contents, machine = item is StardewValley.Object machine ? new { readyForHarvest = machine.readyForHarvest.Value, machine.MinutesUntilReady } : null };
    }
    private static object MoveItemFact(object value)
    {
        InventoryActions.Require(value is Item, "Unknown interior item"); var remaining = 8192; return MoveItem((Item)value, ref remaining)!;
    }
    private static object[] MoveStoredItems(object? source, int cap)
    {
        InventoryActions.Require(source is not null, "Building storage list is unavailable");
        var items = R.Items(source).Take(cap + 1).ToArray(); InventoryActions.Require(items.Length <= cap, "Building storage list exceeds its complete bound");
        return items.Select(MoveItemFact).ToArray();
    }
    private static object MoveHome(FarmAnimal animal)
    {
        // FarmAnimal.homeInterior -> NetLocationRef.Get applies dirty changes
        // and can resolve a location. Read its authoritative network identity
        // fields instead; a query must not refresh caches or load a home.
        var home = R.Raw(animal, "netHomeInterior");
        InventoryActions.Require(home?.GetType().FullName == "StardewValley.Network.NetLocationRef"
            && R.Get(home, "locationName") is string && R.Get(home, "isStructure") is bool, "Animal home network identity unavailable");
        return new { locationId = R.Text(home, "locationName"), isStructure = R.Bool(home, "isStructure") };
    }
    private static GameLocation? MoveInterior(Building building)
    {
        var indoors = R.Get(building, "indoors") as GameLocation; var named = TextOrNull(R.Get(building, "nonInstancedIndoorsName"));
        if (indoors is null && !string.IsNullOrEmpty(named)) indoors = Target(named);
        InventoryActions.Require(indoors is null || indoors.GetType().Assembly == typeof(Game1).Assembly, "Custom building interior needs its own relocation effect adapter");
        return indoors;
    }
    internal sealed record DoorExit(string Key, int X, int Y, string TargetName, int TargetX, int TargetY);
    private static DoorExit[] MoveExits(Building building)
    {
        var inside = MoveInterior(building); if (inside is null) return Array.Empty<DoorExit>();
        var warps = inside.warps.Take(257).ToArray(); InventoryActions.Require(warps.Length <= 256 && warps.All(w => w.GetType().Assembly == typeof(Game1).Assembly), "Unknown or unbounded interior exits");
        return warps.Select(w => new DoorExit(MineActions.Key(w), w.X, w.Y, w.TargetName, w.TargetX, w.TargetY)).OrderBy(w => w.Key, StringComparer.Ordinal).ToArray();
    }
    private static object MoveProtected(Building building, GameLocation target)
    {
        var indoors = MoveInterior(building);
        var furniture = indoors is null ? Array.Empty<object>() : R.Items(R.Get(indoors, "furniture")).Take(1025).ToArray();
        InventoryActions.Require(furniture.Length <= 1024 && furniture.All(f => f is Item), "Incomplete interior furniture capture");
        var residents = indoors is null ? Array.Empty<object>() : R.Items(R.Get(indoors, "animalsThatLiveHere")).Take(257).ToArray();
        InventoryActions.Require(residents.Length <= 256, "Incomplete resident animal identities");
        // Observe actual resident references across already loaded outdoor/interior
        // collections. No Utility.getAnimal/location loader or animal home setter.
        var ids = residents.Select(id => Convert.ToString(R.Unwrap(id), System.Globalization.CultureInfo.InvariantCulture)).OrderBy(id => id, StringComparer.Ordinal).ToArray();
        var locations = new[] { target, indoors }.Where(l => l is not null).Cast<GameLocation>().Distinct().ToArray();
        var animals = locations.SelectMany(l => {
                var present = AnimalCare.In(l); InventoryActions.Require(present.Length <= 512, "Incomplete outdoor/interior animal collection");
                return present.Select(a => new { animal = a, location = l.NameOrUniqueName }); })
            .Where(row => ids.Contains(AnimalCare.Id(row.animal))).OrderBy(row => AnimalCare.Id(row.animal), StringComparer.Ordinal)
            .Select(row => new { id = AnimalCare.Id(row.animal), key = MineActions.Key(row.animal), row.location,
                home = MoveHome(row.animal),
                state = R.Fields(row.animal, "type", "age", "friendshipTowardFarmer", "happiness", "fullness", "currentProduce", "produceQuality", "hasEatenAnimalCracker") }).ToArray();
        InventoryActions.Require(animals.Length == ids.Length && ids.Distinct(StringComparer.Ordinal).Count() == ids.Length, "Resident animal capture is missing or duplicated");
        return new { buildingKey = MineActions.Key(building), fields = R.Fields(building, "parentLocationName", "nonInstancedIndoorsName", "maxOccupants", "currentOccupants", "hayCapacity", "animalDoorOpen", "humanDoor", "animalDoor"),
            buildingChests = MoveStoredItems(R.Get(building, "buildingChests"), 128),
            interior = indoors is null ? null : new { key = MineActions.Key(indoors), locationId = indoors.NameOrUniqueName,
                objects = MovePairs(R.Get(indoors, "Objects"), 4096, MoveItemFact), furniture = furniture.Select(MoveItemFact).ToArray(),
                fridge = R.Get(indoors, "fridge") is Item fridge ? MoveItemFact(fridge) : null }, residents = ids, animals };
    }
    private static Point[] MoveCells(Building b, int x, int y, GameLocation target)
    {
        var rectangles = new List<Rectangle> { new(x, y, b.tilesWide.Value, b.tilesHigh.Value) };
        var extra = b.GetAdditionalPlacementTiles().Take(129).ToArray();
        InventoryActions.Require(extra.Length <= 128, "Incomplete actual additional building footprint");
        foreach (var row in extra) {
            InventoryActions.Require(R.Get(row, "TileArea") is Rectangle, "Unknown additional placement rectangle");
            var r = (Rectangle)R.Get(row, "TileArea")!;
            InventoryActions.Require(r.Width is > 0 and <= 128 && r.Height is > 0 and <= 128, "Unbounded additional building footprint");
            rectangles.Add(new Rectangle(x + r.X, y + r.Y, r.Width, r.Height));
        }
        var cells = new HashSet<Point>(); var layer = target.Map.Layers[0];
        foreach (var r in rectangles) for (var py = r.Top; py < r.Bottom; py++) for (var px = r.Left; px < r.Right; px++) {
            InventoryActions.Require(px >= 0 && py >= 0 && px < layer.LayerWidth && py < layer.LayerHeight && cells.Count < 32768, "Relocation footprint is outside the map or too large"); cells.Add(new Point(px, py));
        }
        return cells.OrderBy(p => p.Y).ThenBy(p => p.X).ToArray();
    }
    internal sealed record GroundCell(int X, int Y, string? ObjectKey, string? ObjectType, string? ItemId, int? Stack, int? Quality, string? TerrainKey, string? TerrainType);
    private static GroundCell[] MoveGround(GameLocation target, Point[] cells) => cells.Select(p => {
        target.Objects.TryGetValue(new Vector2(p.X, p.Y), out var o); target.terrainFeatures.TryGetValue(new Vector2(p.X, p.Y), out var t);
        InventoryActions.Require((o is null || o.GetType().Assembly == typeof(Game1).Assembly) && (t is null || t.GetType().Assembly == typeof(Game1).Assembly), "Custom relocation ground needs its own native effect adapter");
        return new GroundCell(p.X, p.Y, o is null ? null : MineActions.Key(o), o?.GetType().FullName, o?.QualifiedItemId, o?.Stack, o?.Quality,
            t is null ? null : MineActions.Key(t), t?.GetType().FullName);
    }).ToArray();
    private static Building MoveBuilding(GameLocation target, string id)
    {
        var row = Structures(target).SingleOrDefault(b => b.BuildingGuid == id);
        InventoryActions.Require(row is not null, "Use one actual persistent building GUID");
        return R.Items(R.Get(target, "buildings")).Cast<Building>().Single(b => MineActions.Key(b) == row!.BuildingKey);
    }
    private static object? QueryMove(JsonElement args, GameLocation target)
    {
        if (!args.TryGetProperty("moveBuildingGuid", out _)) return null;
        try {
            var building = MoveBuilding(target, R.Arg(args, "moveBuildingGuid"));
            InventoryActions.Require(args.TryGetProperty("movePosition", out var p) && R.Arg(p, "locationId") == target.NameOrUniqueName, "Relocation query needs its exact destination");
            var x = R.Int(p, "x", -1, 0, 10000); var y = R.Int(p, "y", -1, 0, 10000);
            var protection = MoveProtected(building, target); var ground = MoveGround(target, MoveCells(building, x, y, target)); var m = Menu();
            var exits = MoveExits(building);
            return new { available = true, complete = true, building = Fact(building), protection, preservationDigest = Hash(protection), ground, groundDigest = Hash(ground),
                exits, exitDigest = Hash(exits), door = R.Plain(building.humanDoor.Value),
                position = new { locationId = target.NameOrUniqueName, x, y }, canMove = m is null ? (bool?)null : m.hasPermissionsToMove(building),
                note = "Complete enumerations within explicit bounds; preserved fields cover building/interior/item references, ID/quality/stack, local chest contents, held outputs/readiness, furniture and resident identity/home/basic animal state. Not a serialization of every item field or every outside-world effect. Ground rows cover the actual destination plus additional placement tiles. Native UI alone relocates/updates exit warps." };
        } catch (PreconditionRejectedException e) { return new { available = false, complete = false, reason = e.Message }; }
    }
    internal sealed class MoveAttempt
    {
        public string Operation = "", Save = "", Day = "", BuilderLocation = "", Preservation = "", GroundPolicy = "", Direction = "";
        public CarpenterMenu Menu = null!; public GameLocation Target = null!; public Building Building = null!;
        public Structure[] Buildings = Array.Empty<Structure>(); public GroundCell[] Ground = Array.Empty<GroundCell>(); public Point[] Cells = Array.Empty<Point>();
        public DoorExit[] Exits = Array.Empty<DoorExit>();
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>(); public string InventoryDigest = "";
        public object Before = null!; public Point Origin, Destination, PanStart, LastPan; public Point? Pointer;
        public int Gold, Health, X, Y, PanPixels, PanIdleTicks, StableTicks, InitialAction; public float Energy;
        public bool Submitted, InitialOnFarm, PanEnded, ReturnToOrigin; public Building? InitiallyHeld;
    }
    internal static MoveAttempt PrepareMove(JsonElement args)
    {
        InventoryActions.Require(WorldReady() && Game1.player.Items.Count <= 256 && Menu() is not null, "Use the actual open native carpenter menu");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] { "operation", "locationId", "revision", "menuKey", "buildingGuid", "origin", "position", "structureDigest", "inventoryDigest", "expectedGold", "preservationDigest", "groundDigest", "exitDigest", "groundPolicy", "direction", "panPixels", "returnToOrigin" }.Contains(p.Name)), "Unknown relocation argument");
        var m = Menu()!; var target = Target(R.Arg(args, "locationId")); var b = MoveBuilding(target, R.Arg(args, "buildingGuid"));
        InventoryActions.Require(!m.readOnly && !m.freeze && !Game1.IsFading() && !Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null
            && ReferenceEquals(m.TargetLocation, target) && MineActions.Key(m) == R.Arg(args, "menuKey") && Revision(target) == R.Arg(args, "revision"), "Relocation menu/location/revision changed");
        var hasOrigin = args.TryGetProperty("origin", out var origin); var hasDestination = args.TryGetProperty("position", out var destination);
        InventoryActions.Require(hasOrigin && hasDestination
            && R.Arg(origin, "locationId") == target.NameOrUniqueName && R.Arg(destination, "locationId") == target.NameOrUniqueName, "Bind original and destination tiles in this location");
        var a = new MoveAttempt { Operation = R.Arg(args, "operation"), Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), BuilderLocation = m.BuilderLocationName,
            Menu = m, Target = target, Building = b, Buildings = Structures(target), Inventory = InventoryActions.Counts(), InventoryDigest = InventoryActions.Digest(),
            Gold = Game1.player.Money, Health = Game1.player.health, Energy = Game1.player.Stamina, Preservation = Hash(MoveProtected(b, target)), Exits = MoveExits(b),
            Origin = new Point(R.Int(origin, "x", -1, 0, 10000), R.Int(origin, "y", -1, 0, 10000)), Destination = new Point(R.Int(destination, "x", -1, 0, 10000), R.Int(destination, "y", -1, 0, 10000)),
            InitialOnFarm = m.onFarm, InitialAction = Convert.ToInt32(m.Action), InitiallyHeld = m.buildingToMove, GroundPolicy = R.Arg(args, "groundPolicy"),
            ReturnToOrigin = args.TryGetProperty("returnToOrigin", out var recover) && recover.ValueKind == JsonValueKind.True, PanStart = new Point(Game1.viewport.X, Game1.viewport.Y), LastPan = new Point(Game1.viewport.X, Game1.viewport.Y) };
        InventoryActions.Require(new[] { "enter", "pick", "place", "pan", "cancel", "close" }.Contains(a.Operation) && new[] { "preserve", "native_clear" }.Contains(a.GroundPolicy), "Unknown relocation operation or ground policy");
        InventoryActions.Require((b.tileX.Value == a.Origin.X && b.tileY.Value == a.Origin.Y
            || (a.Operation is "cancel" or "close") && b.tileX.Value == a.Destination.X && b.tileY.Value == a.Destination.Y)
            && b.daysOfConstructionLeft.Value == 0 && b.daysUntilUpgrade.Value == 0
            && (m.buildingToMove is null ? !b.isMoving : ReferenceEquals(m.buildingToMove, b) && b.isMoving), "Original building/timers/held identity changed");
        InventoryActions.Require(!args.TryGetProperty("returnToOrigin", out var flag) || flag.ValueKind is JsonValueKind.True or JsonValueKind.False, "Recovery flag must be a boolean");
        InventoryActions.Require(!a.ReturnToOrigin || (a.Operation is "pan" or "place") && a.Destination == a.Origin && ReferenceEquals(m.buildingToMove, b), "Recovery can only normally place this held building at its exact original tile");
        InventoryActions.Require(a.Operation is "cancel" or "close" || a.ReturnToOrigin || Game1.timeOfDay < 2200 && a.Health >= 20 && a.Energy >= 30, "Only native exit/original-position recovery is allowed at resource limits");
        if (a.Operation is "enter" or "close") InventoryActions.Require(!m.onFarm && a.InitialAction == 0 && m.buildingToMove is null && Game1.currentLocation.NameOrUniqueName == a.BuilderLocation, "Use the native builder catalogue");
        else InventoryActions.Require(m.onFarm && a.InitialAction == 2 && ReferenceEquals(Game1.currentLocation, target), "Use the native move placement mode");
        if (a.Operation == "enter") InventoryActions.Require(m.moveButton?.visible == true, "Native move control is not offered");
        if (a.Operation == "pick") InventoryActions.Require(m.buildingToMove is null && m.hasPermissionsToMove(b), "Native building move permission is unavailable");
        if (a.Operation == "place") InventoryActions.Require(ReferenceEquals(m.buildingToMove, b), "The approved building is not actually held");
        if (a.Operation == "cancel") InventoryActions.Require(m.buildingToMove is null, "Native cancel does not cancel a held building; place it normally first");
        a.Cells = MoveCells(b, a.Destination.X, a.Destination.Y, target); a.Ground = MoveGround(target, a.Cells);
        InventoryActions.Require(Hash(a.Buildings) == R.Arg(args, "structureDigest") && a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.Gold == R.Int(args, "expectedGold", -1, 0, int.MaxValue)
            && a.Preservation == R.Arg(args, "preservationDigest") && Hash(a.Ground) == R.Arg(args, "groundDigest") && Hash(a.Exits) == R.Arg(args, "exitDigest"), "Building, storage/residents, exits, ground, inventory or money changed");
        if (a.Operation == "place") {
            InventoryActions.Require(a.GroundPolicy != "preserve" || a.Ground.All(c => c.ObjectKey is null && c.TerrainKey is null), "Preserve policy requires empty affected ground before input");
            InventoryActions.Require(!a.Buildings.Any(row => row.BuildingGuid != Fact(b).BuildingGuid && new Rectangle(row.X, row.Y, row.Width, row.Height)
                .Intersects(new Rectangle(a.Destination.X, a.Destination.Y, b.tilesWide.Value, b.tilesHigh.Value))), "Destination overlaps another building");
        }
        if (a.Operation == "pan") { a.Direction = R.Arg(args, "direction"); InventoryActions.Require(new[] { "left", "right", "up", "down" }.Contains(a.Direction), "Use an explicit camera direction"); a.PanPixels = R.Int(args, "panPixels", 128, 8, 512); }
        a.X = a.Operation == "pick" ? a.Origin.X : a.Destination.X; a.Y = a.Operation == "pick" ? a.Origin.Y : a.Destination.Y;
        a.Before = Query(MoveQueryArgs(a)); return a;
    }
    private static JsonElement MoveQueryArgs(MoveAttempt a) => JsonSerializer.SerializeToElement(new { locationId = a.Target.NameOrUniqueName,
        moveBuildingGuid = Fact(a.Building).BuildingGuid, movePosition = new { locationId = a.Target.NameOrUniqueName, x = a.Destination.X, y = a.Destination.Y } });
    internal static bool MoveContext(MoveAttempt a) => WorldReady() && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day
        && (Game1.currentLocation.NameOrUniqueName == a.BuilderLocation || ReferenceEquals(Game1.currentLocation, a.Target));
    internal static bool BeforeMoveInput(MoveAttempt a) => MoveContext(a) && ReferenceEquals(Menu(), a.Menu) && !a.Menu.freeze && !Game1.IsFading()
        && a.Menu.onFarm == a.InitialOnFarm && Convert.ToInt32(a.Menu.Action) == a.InitialAction && ReferenceEquals(a.Menu.buildingToMove, a.InitiallyHeld)
        && Hash(Structures(a.Target)) == Hash(a.Buildings) && Hash(MoveProtected(a.Building, a.Target)) == a.Preservation && Hash(MoveGround(a.Target, a.Cells)) == Hash(a.Ground)
        && Hash(MoveExits(a.Building)) == Hash(a.Exits)
        && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy;
    internal static Point MovePointer(MoveAttempt a)
    {
        if (a.Operation is "pick" or "place") return PlacementPointer(a.Menu, a.X, a.Y);
        var c = a.Operation == "enter" ? a.Menu.moveButton : a.Menu.cancelButton;
        InventoryActions.Require(c?.visible == true && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(c.bounds.Center), "Actual relocation button unavailable"); return c!.bounds.Center;
    }
    internal static bool MovePointerReady(MoveAttempt a, Point p) => Math.Abs(Game1.getMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getMouseY(true) - p.Y) <= 2
        && Math.Abs(Game1.getOldMouseX(true) - p.X) <= 2 && Math.Abs(Game1.getOldMouseY(true) - p.Y) <= 2
        && (a.Operation is not "pick" and not "place" || (Game1.getMouseX(false) + Game1.viewport.X) / 64 == a.X && (Game1.getMouseY(false) + Game1.viewport.Y) / 64 == a.Y
            && (Game1.getOldMouseX(false) + Game1.viewport.X) / 64 == a.X && (Game1.getOldMouseY(false) + Game1.viewport.Y) / 64 == a.Y);
    internal static void ExecuteMove(MoveAttempt a, Point p)
    {
        InventoryActions.Require(BeforeMoveInput(a), "Relocation preconditions changed before input"); a.Submitted = true; a.Pointer = p;
        // Audited 1.6.15 handler selects/marks the actual building, confirms
        // Farmhouse accessibility and calls normal buildStructure. Never invoke
        // those helpers, clear isMoving, reset home pointers or edit tile fields.
        a.Menu.receiveLeftClick(p.X, p.Y, true);
    }
    internal static void PanMove(MoveAttempt a)
    {
        InventoryActions.Require(BeforeMoveInput(a), "Move camera state changed");
        var scale = Game1.options.uiScale / Game1.options.zoomLevel; InventoryActions.Require(float.IsFinite(scale) && scale > 0, "Native pan scale unavailable");
        var x = a.Direction == "left" ? 1 : a.Direction == "right" ? Game1.viewport.Width - 1 : Game1.viewport.Width / 2;
        var y = a.Direction == "up" ? 1 : a.Direction == "down" ? Game1.viewport.Height - 1 : Game1.viewport.Height / 2;
        var p = new Point((int)(x / scale), (int)(y / scale)); InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Native pan edge unavailable");
        a.Pointer = p; a.Submitted = true; Game1.setMousePosition(p.X, p.Y, true);
        var view = new Point(Game1.viewport.X, Game1.viewport.Y); a.PanIdleTicks = view == a.LastPan ? a.PanIdleTicks + 1 : 0; a.LastPan = view;
        var distance = a.Direction switch { "left" => a.PanStart.X - view.X, "right" => view.X - a.PanStart.X, "up" => a.PanStart.Y - view.Y, _ => view.Y - a.PanStart.Y };
        if (distance >= a.PanPixels || a.PanIdleTicks >= 12) { a.PanEnded = true; StopMovePan(a); }
    }
    internal static void StopMovePan(MoveAttempt a)
    {
        if (a.Operation is not "pan" and not "enter" || !a.Submitted || !Context.IsWorldReady || !ReferenceEquals(Menu(), a.Menu) || !a.Menu.onFarm || a.Pointer is not { } p) return;
        if (Math.Abs(Game1.getMouseX(true) - p.X) <= 3 && Math.Abs(Game1.getMouseY(true) - p.Y) <= 3) Game1.setMousePosition(Game1.uiViewport.Width / 2, Game1.uiViewport.Height / 2, true);
    }
    internal static bool MoveSettled(MoveAttempt a) => MoveContext(a) && !Game1.IsFading() && (a.Operation switch {
        "close" => Game1.activeClickableMenu is null && Context.CanPlayerMove,
        "cancel" => ReferenceEquals(Menu(), a.Menu) && !a.Menu.freeze && !a.Menu.onFarm && Game1.currentLocation.NameOrUniqueName == a.BuilderLocation,
        _ => ReferenceEquals(Menu(), a.Menu) && !a.Menu.freeze && a.Menu.onFarm && Convert.ToInt32(a.Menu.Action) == 2
            && ReferenceEquals(Game1.currentLocation, a.Target) && (a.Operation != "pan" || a.PanEnded) });
    internal static object FinishMove(MoveAttempt a)
    {
        var now = Structures(a.Target); var before = a.Buildings.Single(b => b.BuildingKey == MineActions.Key(a.Building)); var result = now.SingleOrDefault(b => b.BuildingGuid == before.BuildingGuid);
        var accepted = a.Operation == "pick" ? ReferenceEquals(a.Menu.buildingToMove, a.Building) && a.Building.isMoving
            : a.Operation == "place" && a.Menu.buildingToMove is null && !a.Building.isMoving && result?.X == a.Destination.X && result.Y == a.Destination.Y;
        var expected = a.Operation == "pick" && accepted ? before with { IsMoving = true }
            : a.Operation == "place" && accepted ? before with { X = a.Destination.X, Y = a.Destination.Y, IsMoving = false } : before;
        var ground = MoveGround(a.Target, a.Cells); var changes = InventoryActions.Changes(a.Inventory);
        var exits = MoveExits(a.Building);
        var expectedExits = a.Operation == "place" && accepted ? a.Exits.Select(w => w.TargetName == a.Target.NameOrUniqueName
            ? w with { TargetX = a.Building.humanDoor.Value.X + a.Destination.X, TargetY = a.Building.humanDoor.Value.Y + a.Destination.Y + 1 } : w).ToArray() : a.Exits;
        var heldKnown = a.Operation == "pick" ? accepted || a.Menu.buildingToMove is null && !a.Building.isMoving
            : a.Operation == "place" ? accepted || ReferenceEquals(a.Menu.buildingToMove, a.Building) && a.Building.isMoving
            : ReferenceEquals(a.Menu.buildingToMove, a.InitiallyHeld);
        var confirmed = MoveSettled(a) && heldKnown && result == expected && now.Length == a.Buildings.Length
            && Hash(now.Where(b => b.BuildingGuid != before.BuildingGuid)) == Hash(a.Buildings.Where(b => b.BuildingGuid != before.BuildingGuid))
            && changes.Length == 0 && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Gold && Game1.player.health == a.Health && Game1.player.Stamina == a.Energy
            && Hash(MoveProtected(a.Building, a.Target)) == a.Preservation && Hash(exits) == Hash(expectedExits)
            && (a.Operation == "place" && a.GroundPolicy == "native_clear" ? ground.Zip(a.Ground).All(pair => pair.First == pair.Second
                || pair.First == (pair.Second with { ObjectKey = null, ObjectType = null, ItemId = null, Stack = null, Quality = null })
                || pair.First == (pair.Second with { TerrainKey = null, TerrainType = null })
                || pair.First == new GroundCell(pair.Second.X, pair.Second.Y, null, null, null, null, null, null, null)) : Hash(ground) == Hash(a.Ground));
        return new { confirmedEffect = confirmed, completedWorkflow = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Submitted,
            operation = a.Operation, buildingGuid = before.BuildingGuid, pickAccepted = a.Operation == "pick" && accepted, placementAccepted = a.Operation == "place" && accepted,
            returnToOrigin = a.ReturnToOrigin, preservationVerified = confirmed, exitsVerified = confirmed, exitsBefore = a.Exits, exitsAfter = exits,
            groundPolicy = a.GroundPolicy, groundBefore = a.Ground, groundAfter = ground,
            panDelta = new { x = Game1.viewport.X - a.PanStart.X, y = Game1.viewport.Y - a.PanStart.Y }, result, inventoryChanges = changes, goldBefore = a.Gold, goldAfter = Game1.player.Money,
            before = a.Before, after = Query(MoveQueryArgs(a)),
            note = "Known native pick/place rejection is reported separately. Held buildings cannot be cancelled: only an explicitly approved normal placement at the original position can return them. No silent rollback, forced tile/home/warp writes, replay or reusable move authorization. Only the listed preservation fields are verified." };
    }
}
