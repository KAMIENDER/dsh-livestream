using System.Globalization;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Manual trough preparation and passive spawned produce/forage collection via native player actions.</summary>
internal static class HusbandryActions
{
    private const string Hay = "(O)178"; // AnimalHouse.checkAction checks this exact qualified ID in the inspected build.
    private sealed record Spot(string LocationId, int X, int Y) { public Vector2 Tile => new(X, Y); }
    private sealed record Stock(string LocationId, int Hay, int Capacity);
    private static object Position(Spot spot) => new { spot.LocationId, spot.X, spot.Y };
    private static Spot SpotAt(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var p) && p.ValueKind == JsonValueKind.Object, "Use an actual queried position");
        var spot = new Spot(R.Arg(p, "locationId"), R.Int(p, "x", -1, 0, 10000), R.Int(p, "y", -1, 0, 10000));
        InventoryActions.Require(spot.LocationId == Game1.currentLocation.NameOrUniqueName, "Target must be in the current loaded location");
        var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(spot.X < layer.LayerWidth && spot.Y < layer.LayerHeight, "Target is outside the actual map");
        return spot;
    }
    private static bool Trough(Spot spot) => Game1.currentLocation is AnimalHouse
        && Game1.currentLocation.doesTileHaveProperty(spot.X, spot.Y, "Trough", "Back", false) is not null;
    private static SObject? At(Spot spot) => Game1.currentLocation.Objects.TryGetValue(spot.Tile, out var item) ? item : null;
    private static string Digest(Spot spot) => GameFacts.Hash(JsonSerializer.Serialize(new { position = Position(spot), trough = Trough(spot),
        item = At(spot) is { } item ? new { item.QualifiedItemId, item.Stack, item.Quality, spawned = item.isSpawnedObject.Value,
            grabbable = item.canBeGrabbed.Value, questItem = item.questItem.Value, bigCraftable = item.bigCraftable.Value } : null }, LocalServer.Json));
    private static Stock[] Stocks() => Game1.locations.Select(location => new Stock(location.NameOrUniqueName, location.piecesOfHay.Value, location.GetHayCapacity()))
        .Where(stock => stock.Hay > 0 || stock.Capacity > 0).OrderBy(stock => stock.LocationId, StringComparer.Ordinal).ToArray();
    private static bool Reachable(Spot spot) => Math.Abs((int)Game1.player.Tile.X - spot.X) + Math.Abs((int)Game1.player.Tile.Y - spot.Y) <= 1;
    private static bool ActorOn(Spot spot)
    {
        var tile = new Rectangle(spot.X * 64, spot.Y * 64, 64, 64);
        return Game1.currentLocation.characters.Any(character => character.GetBoundingBox().Intersects(tile))
            || AnimalCare.In(Game1.currentLocation).Any(animal => animal.GetBoundingBox().Intersects(tile));
    }
    private static HashSet<string> AnimalProduceIds()
    {
        var data = R.Get(typeof(Game1), "farmAnimalData") ?? throw new InvalidOperationException("Actual animal data is unavailable");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var pair in R.Items(data))
        {
            var animal = R.Raw(pair, "Value");
            foreach (var field in new[] { "ProduceItemIds", "DeluxeProduceItemIds" })
                foreach (var rule in R.Items(R.Get(animal, field)))
                    if (R.Get(rule, "ItemId") is string id && !string.IsNullOrWhiteSpace(id)) ids.Add(ItemRegistry.QualifyItemId(id));
            foreach (var egg in R.Items(R.Get(animal, "EggItemIds")))
                if (egg is string id && !string.IsNullOrWhiteSpace(id)) ids.Add(ItemRegistry.QualifyItemId(id));
        }
        return ids;
    }
    // checkAction clones getOne() then removes the whole tile. Item.GetOneCopyFrom explicitly
    // sets Stack=1, so using this path on a stacked source would lose the remaining quantity.
    // Inspected dayUpdate spawns cracker extras separately; stacked sources need another path.
    private static bool Passive(SObject item, HashSet<string> produce) => item.GetType() == typeof(SObject) && item.Stack == 1 && item.isSpawnedObject.Value && item.canBeGrabbed.Value
        && !item.bigCraftable.Value && !item.questItem.Value && item.GetMachineData() is null && (item.isForage() || produce.Contains(item.QualifiedItemId));
    private static object Ground(Spot spot, HashSet<string> produce)
    {
        var item = At(spot);
        var passive = item is not null && Passive(item, produce);
        // checkAction may recompute forage quality and give Gatherer's native duplicate.
        // Do not run its RNG in a query. Reserve the possible bonus at each possible quality.
        var qualities = item is not null && item.isForage() ? new[] { 0, 1, 2, 4 } : new[] { item?.Quality ?? 0 };
        var bonusPossible = item is not null && !item.questItem.Value && Game1.player.professions.Contains(13) && !Game1.currentLocation.isFarmBuildingInterior(); // Native Gatherer ID/branch.
        var maximumGain = item is not null && item.Stack == 1 ? bonusPossible ? 2 : 1 : 0;
        var capacity = passive && maximumGain > 0
            && qualities.All(quality => Game1.player.couldInventoryAcceptThisItem(item!.QualifiedItemId, maximumGain, quality));
        return new { position = Position(spot), digest = Digest(spot), itemId = item?.QualifiedItemId, quality = item?.Quality, count = item?.Stack,
            spawned = item?.isSpawnedObject.Value, grabbable = item?.canBeGrabbed.Value, nativeForage = item?.isForage(),
            animalCatalogMatch = item is not null && produce.Contains(item.QualifiedItemId), eligible = passive,
            actorBlocked = ActorOn(spot), inventoryCapacityForWorstCase = capacity, maximumNativeGain = maximumGain,
            gathererBonusPossible = bonusPossible, stackedSourceUnsupported = item is not null && item.Stack != 1,
            origin = "Actual spawned ground object; catalog membership does not prove which animal produced it." };
    }
    private static object FeedSpot(Spot spot) => new { position = Position(spot), digest = Digest(spot), trough = Trough(spot),
        occupiedItemId = At(spot)?.QualifiedItemId, occupiedCount = At(spot)?.Stack, occupiedQuality = At(spot)?.Quality,
        empty = At(spot) is null, actorBlocked = ActorOn(spot) };

    public static object Query(JsonElement args)
    {
        var section = R.Arg(args, "section", "house");
        InventoryActions.Require(section is "house" or "ground", "section must be house or ground");
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 30, 1, 100);
        var produce = section == "ground" ? AnimalProduceIds() : new HashSet<string>(StringComparer.Ordinal);
        var spots = new List<Spot>();
        if (args.TryGetProperty("position", out _)) spots.Add(SpotAt(args));
        else if (section == "ground") spots.AddRange(Game1.currentLocation.Objects.Keys.OrderBy(tile => tile.Y).ThenBy(tile => tile.X)
            .Where(tile => Game1.currentLocation.Objects[tile].isSpawnedObject.Value).Select(tile => new Spot(Game1.currentLocation.NameOrUniqueName, (int)tile.X, (int)tile.Y)));
        else if (Game1.currentLocation is AnimalHouse)
        {
            var layer = Game1.currentLocation.Map.Layers[0];
            InventoryActions.Require((long)layer.LayerWidth * layer.LayerHeight <= 100000, "House map is too large for a complete scan; query exact positions instead");
            for (var y = 0; y < layer.LayerHeight; y++) for (var x = 0; x < layer.LayerWidth; x++)
            {
                var spot = new Spot(Game1.currentLocation.NameOrUniqueName, x, y);
                if (Trough(spot)) spots.Add(spot);
            }
        }
        var rows = spots.Skip(offset).Take(limit).Select(spot => section == "house" ? FeedSpot(spot) : Ground(spot, produce)).ToArray();
        var house = Game1.currentLocation as AnimalHouse;
        return new { section, locationId = Game1.currentLocation.NameOrUniqueName, offset, count = spots.Count, items = rows,
            nextOffset = offset + limit < spots.Count ? (int?)(offset + limit) : null, inventoryDigest = InventoryActions.Digest(),
            house = house is null ? null : new { animalLimit = house.animalLimit.Value, presentAnimals = AnimalCare.In(house).Length,
                residentIds = R.Items(house.animalsThatLiveHere).Select(value => Convert.ToString(R.Unwrap(value), CultureInfo.InvariantCulture)).ToArray(),
                nativeAutoFeed = house.HasMapPropertyWithValue("AutoFeed") },
            siloStocks = Stocks(), hayItemId = Hay,
            note = "Current loaded location only. Filling troughs prepares feed; it does not immediately prove animals ate. Silo stocks are loaded root locations; no hay is extracted and no automatic-feeder method is invoked. Ground quality/bonus are decided by the native pickup action, not query RNG." };
    }

    public static object Act(JsonElement args)
    {
        InventoryActions.Require(Context.CanPlayerMove && !Game1.eventUp && Game1.activeClickableMenu is null && !Game1.player.UsingTool, "Finish actions and close menus before husbandry interaction");
        var spot = SpotAt(args); var operation = R.Arg(args, "operation");
        InventoryActions.Require(operation is "feed" or "collect_ground", "Unknown husbandry operation");
        InventoryActions.Require(Reachable(spot) && !ActorOn(spot), "Approach adjacent and requery; an animal/NPC may block the tile");
        InventoryActions.Require(R.Arg(args, "targetDigest") == Digest(spot) && R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "Target or inventory changed; requery before submitting");
        var beforeItems = InventoryActions.Counts(); var beforeStocks = Stocks(); var before = operation == "feed" ? FeedSpot(spot) : Ground(spot, AnimalProduceIds());
        var beforeLocation = Game1.currentLocation; var beforeTile = Game1.player.Tile; var beforeDay = GameFacts.DayKey();
        var source = At(spot); var sourceCount = source?.Stack ?? 0; var expected = R.Arg(args, "expectedItemId");
        var quality = 0;
        if (operation == "feed")
        {
            InventoryActions.Require(Trough(spot) && source is null && expected == Hay, "Feed only an empty native Trough in an AnimalHouse");
            var slot = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1); quality = R.Int(args, "expectedQuality", -1, 0, 4);
            InventoryActions.Require(Game1.player.Items[slot] is SObject hay && hay.QualifiedItemId == Hay && hay.Stack > 0 && hay.Quality == quality, "Use an actual owned hay stack of the requested quality");
            Game1.player.CurrentToolIndex = slot;
            if (Game1.player.ActiveObject?.QualifiedItemId != Hay) throw new InvalidOperationException("Native active hay was not confirmed");
        }
        else
        {
            InventoryActions.Require(source is not null && source.QualifiedItemId == expected && Passive(source, AnimalProduceIds()), "Only queried passive spawned animal produce/forage can be collected");
            InventoryActions.Require(source!.Quality == R.Int(args, "expectedQuality", -1, 0, 4) && source.Stack > 0
                && source.Stack <= R.Int(args, "maxSourceCount", 0, 1, 1), "Ground quality or source stack exceeds the requested envelope");
            InventoryActions.Require(R.Bool(before, "inventoryCapacityForWorstCase"), "Insufficient capacity for native quality and Gatherer bonus; store items first");
            var neutral = Enumerable.Range(0, Game1.player.Items.Count).Where(index => Game1.player.Items[index] is null or Tool).DefaultIfEmpty(-1).First();
            InventoryActions.Require(neutral >= 0, "An actual empty or tool slot is required to avoid placing a held object");
            Game1.player.CurrentToolIndex = neutral;
            if (Game1.player.ActiveObject is not null) throw new InvalidOperationException("Native empty-hand/tool selection was not confirmed");
        }
        var dx = spot.X - (int)Game1.player.Tile.X; var dy = spot.Y - (int)Game1.player.Tile.Y;
        if (dx != 0 || dy != 0) Game1.player.faceDirection(dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0);
        var acted = Game1.currentLocation.checkAction(new xTile.Dimensions.Location(spot.X, spot.Y), Game1.viewport, Game1.player);
        var changes = InventoryActions.Changes(beforeItems); var itemAfter = At(spot);
        var sameStocks = JsonSerializer.Serialize(beforeStocks, LocalServer.Json) == JsonSerializer.Serialize(Stocks(), LocalServer.Json);
        var context = ReferenceEquals(beforeLocation, Game1.currentLocation) && beforeTile == Game1.player.Tile && beforeDay == GameFacts.DayKey()
            && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.player.UsingTool;
        var confirmed = acted && context && sameStocks && (operation == "feed"
            ? itemAfter is not null && itemAfter.QualifiedItemId == Hay && itemAfter.Stack == 1 && itemAfter.Quality == quality
                && changes.Length == 1 && changes[0].ItemId == Hay && changes[0].Quality == quality && changes[0].Amount == -1
            : itemAfter is null && changes.Length > 0 && changes.All(change => change.ItemId == expected && change.Amount > 0)
                && changes.Sum(change => change.Amount) >= sourceCount && changes.Sum(change => change.Amount) <= Convert.ToInt32(R.Get(before, "maximumNativeGain")));
        var unchanged = !acted && context && sameStocks && changes.Length == 0 && R.Arg(args, "targetDigest") == Digest(spot);
        return new { operation, completedWorkflow = confirmed, completionUncertain = !confirmed && !unchanged, nativeActionReturned = acted,
            position = Position(spot), before, after = operation == "feed" ? FeedSpot(spot) : Ground(spot, AnimalProduceIds()),
            inventoryChanges = changes, beforeSiloStocks = beforeStocks, afterSiloStocks = Stocks(), siloUnchanged = sameStocks,
            hayConsumed = operation == "feed" && confirmed ? 1 : 0, filledTrough = operation == "feed" && confirmed,
            note = "Uses the player's native checkAction. Feed preparation is not proof of eating; no silo extraction, forced auto-feed, fullness edits, item grants or automatic replay." };
    }
}
