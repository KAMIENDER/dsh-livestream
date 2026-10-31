using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>Actual owned rods, native attachment operations and location rules; no fish or gear grants.</summary>
internal static class FishingActions
{
    internal sealed record Attachment(int Index, string? ItemId, int Quality, int Stack, int? Uses);
    internal sealed record Total(string ItemId, int Quality, long Amount);
    public static Attachment[] Attachments(FishingRod rod) => Enumerable.Range(0, rod.attachments.Length).Select(index => {
        var item = rod.attachments[index];
        return new Attachment(index, item?.QualifiedItemId, item?.Quality ?? 0, item?.Stack ?? 0, item is null ? null : (int?)item.uses.Value);
    }).ToArray();
    public static string GearDigest(FishingRod rod) => GameFacts.Hash(JsonSerializer.Serialize(new { rod.QualifiedItemId, rod.UpgradeLevel, attachments = Attachments(rod) }, LocalServer.Json));
    public static FishingRod Rod(int slot, string expected)
    {
        InventoryActions.Require(slot >= 0 && slot < Game1.player.Items.Count && Game1.player.Items[slot] is FishingRod, "rodSlot must identify an actual owned fishing rod");
        var rod = (FishingRod)Game1.player.Items[slot];
        InventoryActions.Require(rod.QualifiedItemId == expected, "Rod item identity changed");
        return rod;
    }
    private static Total[] Totals()
    {
        var items = Game1.player.Items.Where(item => item is not null).ToList();
        foreach (var tool in Game1.player.Items.OfType<Tool>())
            for (var i = 0; i < tool.attachments.Length; i++) if (tool.attachments[i] is { } attached) items.Add(attached);
        return items.GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(group => new Total(group.Key.QualifiedItemId, group.Key.Quality, group.Sum(item => (long)item.Stack)))
            .OrderBy(total => total.ItemId, StringComparer.Ordinal).ThenBy(total => total.Quality).ToArray();
    }
    private static bool Conserved(Total[] before) => JsonSerializer.Serialize(before, LocalServer.Json) == JsonSerializer.Serialize(Totals(), LocalServer.Json);
    private static bool Owned(Item candidate) => Game1.player.Items.Any(item => ReferenceEquals(item, candidate))
        || Game1.player.Items.OfType<Tool>().Any(tool => Enumerable.Range(0, tool.attachments.Length).Any(index => ReferenceEquals(tool.attachments[index], candidate)));
    private static void ReturnUnowned(Item? item, int preferredSlot)
    {
        if (item is null || item.Stack <= 0 || Owned(item)) return;
        var slot = Game1.player.Items[preferredSlot] is null ? preferredSlot : Enumerable.Range(0, Game1.player.Items.Count).Where(index => Game1.player.Items[index] is null).DefaultIfEmpty(-1).First();
        if (slot < 0) throw new InvalidOperationException("Native attachment transfer has an unowned item and no reserved recovery slot");
        Game1.player.Items[slot] = item;
    }
    public static object Query(JsonElement args)
    {
        var location = Game1.currentLocation;
        var layer = location.Map.Layers[0];
        var origin = Game1.player.Tile;
        var water = new List<object>();
        for (var direction = 0; direction < 4; direction++)
        {
            var offset = direction switch { 0 => new Point(0, -1), 1 => new Point(1, 0), 2 => new Point(0, 1), _ => new Point(-1, 0) };
            for (var distance = 1; distance <= 12; distance++)
            {
                var x = (int)origin.X + offset.X * distance; var y = (int)origin.Y + offset.Y * distance;
                if (x < 0 || y < 0 || x >= layer.LayerWidth || y >= layer.LayerHeight) break;
                if (location.isTileFishable(x, y)) water.Add(new { direction, distance, position = new { locationId = location.NameOrUniqueName, x, y } });
            }
        }
        var currentData = location.GetData();
        var defaultEntry = R.Items(R.Get(typeof(Game1), "locationData")).FirstOrDefault(entry => R.Text(entry, "Key") == "Default");
        var defaultData = R.Raw(defaultEntry, "Value");
        var rules = R.Items(R.Get(currentData, "Fish")).Select(rule => new { source = "current_location", rule })
            .Concat(R.Items(R.Get(defaultData, "Fish")).Select(rule => new { source = "Default", rule })).ToArray();
        var offset = R.Int(args, "ruleOffset", 0, 0, 100000); var limit = R.Int(args, "ruleLimit", 30, 1, 50);
        return new {
            locationId = location.NameOrUniqueName, position = new { locationId = location.NameOrUniqueName, x = (int)origin.X, y = (int)origin.Y },
            canFishHere = location.canFishHere(), fishableRayTiles = water,
            inventoryDigest = InventoryActions.Digest(), emptyInventorySlots = Game1.player.Items.Count(item => item is null),
            rods = Game1.player.Items.Select((item, index) => (item, index)).Where(row => row.item is FishingRod).Select(row => {
                var rod = (FishingRod)row.item;
                return new { slot = row.index, itemId = rod.QualifiedItemId, upgradeLevel = rod.UpgradeLevel, selected = ReferenceEquals(rod, Game1.player.CurrentTool),
                    canUseBait = rod.CanUseBait(), canUseTackle = rod.CanUseTackle(), attachmentSlots = rod.AttachmentSlotsCount,
                    attachments = Attachments(rod), gearDigest = GearDigest(rod), inUse = rod.inUse(), showingTreasure = rod.showingTreasure,
                    eligibleInventoryGear = Game1.player.Items.Select((gear, index) => (gear, index))
                        .Where(candidate => candidate.gear is StardewValley.Object obj && rod.canThisBeAttached(obj)).Select(candidate => new {
                            inventorySlot = candidate.index, itemId = candidate.gear.QualifiedItemId, quality = candidate.gear.Quality,
                            stack = candidate.gear.Stack, uses = ((StardewValley.Object)candidate.gear).uses.Value,
                        }).ToArray() };
            }).ToArray(),
            fishRules = rules.Skip(offset).Take(limit).Select(row => new { row.source, value = JsonSerializer.SerializeToElement(row.rule, LocalServer.Json) }).ToArray(),
            fishRuleCount = rules.Length, ruleOffset = offset, nextRuleOffset = offset + limit < rules.Length ? (int?)(offset + limit) : null,
            currentLocationDataAvailable = currentData is not null, defaultLocationDataAvailable = defaultData is not null,
            note = "Ray tiles are current native fishability, not a guaranteed cast landing or species. Current/Default fish rules are literal data, not evaluated random conditions or a complete list of hardcoded special rewards. Native casting, bait, season/time/weather and special locations decide the actual result.",
        };
    }

    public static object Gear(JsonElement args)
    {
        InventoryActions.Require(Context.CanPlayerMove && !Game1.eventUp && Game1.activeClickableMenu is null && !Game1.player.UsingTool, "Finish native actions and close menus before changing fishing gear");
        InventoryActions.Require(R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "stale_inventory: query current inventory again");
        var slot = R.Int(args, "rodSlot", -1, 0, Game1.player.Items.Count - 1);
        var rod = Rod(slot, R.Arg(args, "expectedRodItemId"));
        InventoryActions.Require(!rod.inUse() && !rod.showingTreasure && R.Arg(args, "gearDigest") == GearDigest(rod), "stale_gear: query idle rod attachments again");
        var operation = R.Arg(args, "operation");
        InventoryActions.Require(operation is "attach" or "detach_first", "Only native attach or detach_first is supported");
        var inventorySlot = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1);
        var expectedIndex = R.Int(args, "attachmentIndex", -1, 0, rod.attachments.Length - 1);
        InventoryActions.Require(slot != inventorySlot, "Rod and gear destination/source slots must differ");
        StardewValley.Object? source = null;
        if (operation == "attach")
        {
            source = Game1.player.Items[inventorySlot] as StardewValley.Object;
            InventoryActions.Require(source is not null && source.QualifiedItemId == R.Arg(args, "expectedItemId") && source.Quality == R.Int(args, "expectedQuality", -1, 0, 4)
                && source.Stack > 0 && source.Stack <= R.Int(args, "maxCount", 0, 1, 10000), "Source must be a bounded actual gear stack; split oversized stacks first");
            InventoryActions.Require(rod.canThisBeAttached(source), "Native rod rejects this attachment");
        }
        else
        {
            InventoryActions.Require(Game1.player.Items[inventorySlot] is null, "Detaching needs a real empty inventory slot");
            var first = Array.FindIndex(Attachments(rod), fact => fact.ItemId is not null);
            InventoryActions.Require(first >= 0 && first == expectedIndex && rod.attachments[first].QualifiedItemId == R.Arg(args, "expectedItemId")
                && rod.attachments[first].Quality == R.Int(args, "expectedQuality", -1, 0, 4)
                && rod.attachments[first].Stack <= R.Int(args, "maxCount", 0, 1, 10000), "Native detach removes the first occupied whole stack; requested attachment identity or quantity budget changed");
        }
        var before = Attachments(rod); var totals = Totals(); var old = rod.attachments[expectedIndex];
        var beforeReferences = Enumerable.Range(0, rod.attachments.Length).Select(index => rod.attachments[index]).ToArray();
        InventoryActions.Require(operation != "attach" || beforeReferences.All(item => item is null) || Game1.player.Items.Any(item => item is null), "Attaching beside existing gear needs one spare recovery slot");
        // Match native inventory ownership: the source is held outside the bag while attach
        // moves/merges it. Leaving it in the bag during attach could retain the same reference
        // both there and on the rod if a native callback throws after the attachment changes.
        StardewValley.Object? returned = null;
        Game1.player.Items[inventorySlot] = null;
        try {
            returned = rod.attach(source);
            if (returned is not null && Owned(returned)) throw new InvalidOperationException("Native attach returned an already-owned item reference");
            ReturnUnowned(returned, inventorySlot);
        }
        catch {
            // Preserve existing unowned references, never clone items or restore old stack
            // quantities. This does not undo the attachment; the overall result stays unknown.
            ReturnUnowned(returned, inventorySlot); ReturnUnowned(source, inventorySlot);
            foreach (var previous in beforeReferences) ReturnUnowned(previous, inventorySlot);
            throw;
        }
        var after = Attachments(rod);
        var changed = before.Where((fact, index) => fact != after[index]).Select(fact => fact.Index).ToArray();
        var confirmed = Conserved(totals) && changed.Length == 1 && changed[0] == expectedIndex
            && (operation == "detach_first" ? ReferenceEquals(returned, old) && rod.attachments[expectedIndex] is null
                : rod.attachments[expectedIndex]?.QualifiedItemId == R.Arg(args, "expectedItemId"));
        var unchanged = changed.Length == 0 && ReferenceEquals(returned, source) && R.Arg(args, "inventoryDigest") == InventoryActions.Digest() && Conserved(totals);
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed && !unchanged, operation, rodSlot = slot, attachmentIndex = expectedIndex, inventorySlot,
            beforeAttachments = before, afterAttachments = after, inventoryDigest = InventoryActions.Digest(), gearDigest = GearDigest(rod), conservedQuantity = confirmed };
    }
}
