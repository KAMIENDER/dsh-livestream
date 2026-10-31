using System.Globalization;
using System.Text.Json;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Characters;
using StardewValley.Tools;

namespace DshStardew;

internal static partial class ConstructionActions
{
    private sealed record RecoveryRoot(int Slot, Item Item);
    private static object RecoveryRootFact(RecoveryRoot row, string? reason = null) => new {
        sourceSlot = row.Slot, key = MineActions.Key(row.Item), itemId = row.Item.QualifiedItemId, row.Item.Stack, row.Item.Quality,
        type = row.Item.GetType().FullName, typeToken = $"0x{row.Item.GetType().MetadataToken:x8}",
        upgradeLevel = row.Item is Tool ? R.Get(row.Item, "upgradeLevel") : null, reason,
    };
    private static object CabinBagRecovery(object?[] slots)
    {
        InventoryActions.Require(Supported() && slots.Length <= 256 && slots.All(v => v is null or Item), "Unknown cabin bag recovery input");
        var original = slots.Select((item, slot) => new { item, slot }).Where(row => row.item is not null)
            .Select(row => new RecoveryRoot(row.slot, (Item)row.item!)).ToArray();
        InventoryActions.Require(original.All(row => row.Item.GetType().Module == typeof(Game1).Module && row.Item.Stack is > 0 and <= 10000)
            && original.Select(row => MineActions.Key(row.Item)).Distinct(StringComparer.Ordinal).Count() == original.Length, "Custom/duplicate/unbounded cabin bag items require another recovery model");
        var retained = original.ToList(); var removed = new List<object>();
        // Exact GetType equality, strict lower upgrade comparison, then one
        // List.Remove: ties keep the first root in original inventory order.
        // Operate solely on our reference list; never call removeInitialTools,
        // clear an inventory, clone an item, or call a native setter/predicate.
        foreach (var token in new[] { 0x02000127, 0x0200012b, 0x02000135, 0x02000130 }) {
            RecoveryRoot? lowest = null; var level = int.MaxValue;
            foreach (var row in retained) {
                if (row.Item.GetType().MetadataToken != token) continue;
                InventoryActions.Require(row.Item is Tool && R.Get(row.Item, "upgradeLevel") is int n && n is >= 0 and <= 10000, "Unknown native tool upgrade level");
                var current = (int)R.Get(row.Item, "upgradeLevel")!;
                if (lowest is null || current < level) { lowest = row; level = current; }
            }
            if (lowest is not null) { retained.Remove(lowest); removed.Add(RecoveryRootFact(lowest, "lowest_upgrade_exact_native_tool_type")); }
        }
        // Exact native predicate <removeInitialTools>b__517_0: first
        // MeleeWeapon whose unqualified ItemId is 47, including its subclasses.
        var scythe = retained.FirstOrDefault(row => row.Item is MeleeWeapon && row.Item.ItemId == "47");
        if (scythe is not null) { retained.Remove(scythe); removed.Add(RecoveryRootFact(scythe, "first_native_melee_weapon_item_id_47")); }
        return new { filterModelComplete = true, filterModelVerifiedInGame = false, observedNonNullRootCount = original.Length,
            removedFromRecoveryChest = removed.ToArray(), retainedBagRoots = retained.Select(row => RecoveryRootFact(row)).ToArray(),
            recoveredChestVerified = false, fullDemolitionRecoveryModelComplete = false,
            note = "Read-only mirror of this exact build's cabin bag null filter/removeInitialTools order. Upgraded tools can be excluded. Retained means native planned bag roots, not a verified spawned chest, successful recovery, full item-field backup or equipment recovery. Quest-item cloning, other containers, character/cellar changes and hooks are separate." };
    }
    private static GameLocation[] DemolitionLoadedScope(GameLocation target)
    {
        var roots = Game1.locations.Take(513).ToArray(); InventoryActions.Require(roots.Length <= 512, "Loaded location roots exceed the complete search bound");
        var pending = new Queue<GameLocation>(roots.Concat(new[] { Game1.currentLocation, target })); var seen = new HashSet<GameLocation>();
        while (pending.Count > 0) {
            var location = pending.Dequeue(); if (!seen.Add(location)) continue;
            InventoryActions.Require(seen.Count <= 512, "Loaded demolition scope exceeds its complete bound");
            var buildings = DemolitionRows(R.Get(location, "buildings"), 256);
            foreach (var value in buildings) {
                InventoryActions.Require(value is Building, "Unknown loaded building reference");
                if (R.Get(value, "indoors") is GameLocation indoors && !seen.Contains(indoors)) pending.Enqueue(indoors);
            }
        }
        return seen.OrderBy(l => l.NameOrUniqueName, StringComparer.Ordinal).ThenBy(l => MineActions.Key(l), StringComparer.Ordinal).ToArray();
    }
    private static object? DemolitionHorse(Building building, GameLocation target)
    {
        if (building is not Stable) return null;
        // Stable.HorseId is exactly Building.id.Value in this build. Never call
        // getStableHorse/findHorse or resolve locations to make this projection.
        var wanted = R.Get(building, "id"); InventoryActions.Require(wanted is Guid g && g != Guid.Empty, "Stable persistent horse identity unavailable");
        var locations = DemolitionLoadedScope(target); var rows = new List<object>();
        foreach (var location in locations) foreach (var value in DemolitionRows(R.Get(location, "characters"), 512)) {
            if (value is not Horse horse || R.Get(horse, "horseId") is not Guid id || id != (Guid)wanted!) continue;
            InventoryActions.Require(horse.GetType().Assembly == typeof(Game1).Assembly, "Custom stable horse requires its own loss model");
            var rider = R.Raw(horse, "netRider");
            InventoryActions.Require(R.Get(rider, "defined") is bool && R.Get(rider, "uid") is long && R.Get(horse, "ownerId") is long, "Unknown horse owner/rider fields");
            rows.Add(new { key = MineActions.Key(horse), horseId = id.ToString("D"), locationId = location.NameOrUniqueName,
                ownerId = ((long)R.Get(horse, "ownerId")!).ToString(CultureInfo.InvariantCulture), riderDefined = R.Bool(rider, "defined"),
                riderId = R.Bool(rider, "defined") ? ((long)R.Get(rider, "uid")!).ToString(CultureInfo.InvariantCulture) : null,
                mounting = R.Get(horse, "mounting"), dismounting = R.Get(horse, "dismounting"),
                hat = R.Get(horse, "hat") is Item hat ? MoveItemFact(hat) : null });
        }
        InventoryActions.Require(rows.Count <= 16, "Ambiguous/unbounded matching stable horses");
        return new { horseId = ((Guid)wanted!).ToString("D"), loadedScopeComplete = true, loadedLocationCount = locations.Length,
            matches = rows.ToArray(), nativeFindHorseParityVerified = false, removalReceiptVerified = false,
            note = "Stable.performActionOnDemolition calls base removal, finds the stable horse, then removes it from its containing characters collection. This read only lists matching horses in roots/current/target and cached instanced interiors; missing here does not prove the native global search finds none. Horse/rider/hat loss and recovery need explicit execution postconditions." };
    }
    private static object ObservedDemolitionQuestItems(object contents, object? interior, object? cellar)
    {
        var candidates = new Dictionary<string, (JsonElement Item, List<string> Paths)>(); var nodes = 0;
        void Visit(JsonElement value, string path) {
            InventoryActions.Require(++nodes <= 200000, "Quest candidate snapshot exceeds its complete traversal bound");
            if (value.ValueKind == JsonValueKind.Object) {
                if (value.TryGetProperty("questItem", out var quest) && quest.ValueKind == JsonValueKind.True) {
                    InventoryActions.Require(value.TryGetProperty("key", out var key) && key.ValueKind == JsonValueKind.String && value.TryGetProperty("id", out _)
                        && value.TryGetProperty("stack", out _) && value.TryGetProperty("quality", out _), "Incomplete observed quest item");
                    var id = key.GetString()!;
                    if (!candidates.TryGetValue(id, out var row)) { row = (value.Clone(), new List<string>()); candidates.Add(id, row); }
                    row.Paths.Add(path);
                }
                foreach (var p in value.EnumerateObject()) Visit(p.Value, path + "." + p.Name);
            } else if (value.ValueKind == JsonValueKind.Array) {
                var i = 0; foreach (var row in value.EnumerateArray()) Visit(row, path + "[" + (i++).ToString(CultureInfo.InvariantCulture) + "]");
            }
        }
        Visit(JsonSerializer.SerializeToElement(new { contents, interior, cellar }, LocalServer.Json), "observed");
        return new { candidates = candidates.OrderBy(r => r.Key, StringComparer.Ordinal).Select(r => new {
                key = r.Key, itemId = r.Value.Item.GetProperty("id").GetString(), stack = r.Value.Item.GetProperty("stack").GetInt32(),
                quality = r.Value.Item.GetProperty("quality").GetInt32(), paths = r.Value.Paths.ToArray() }).ToArray(),
            nativeTraversalComplete = false, recoveryPredictionComplete = false, returnedDonationsReceiptVerified = false,
            note = "Observed Object.questItem candidates only. BeforeDemolish copies quest objects it traverses to returnedDonations. Multiple snapshot paths are not a native visit/count contract; unmodeled child-item traversal and subclass hooks are not silently treated as empty. No cloning/removal/native traversal callback is run." };
    }
}
