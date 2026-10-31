using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Read already-loaded stones, tools and debris. No loot, price, ladder or RNG simulation.</summary>
internal static class MiningFacts
{
    private const string Build = "e2d77e0c-417e-41ec-b5ab-ab6e915ce317";
    private static string Digest(object value) => GameFacts.Hash(JsonSerializer.Serialize(value, LocalServer.Json));
    internal sealed record Rock(string TargetKey, string Digest, string LocationId, int X, int Y, string ItemId, int Quality, int Durability, bool Blocked);
    private static Rock? Stone(MineShaft mine, Vector2 tile, SObject obj, object[] clumps)
    {
        // Exact ordinary Object only. IsBreakableStone is the inspected pure
        // Category == -999 && Name == "Stone" predicate, not a tool action.
        if (obj.GetType() != typeof(SObject) || !obj.IsBreakableStone()) return null;
        var x = (int)tile.X; var y = (int)tile.Y;
        var blocked = obj.Stack != 1 || obj.Quality is < 0 or > 4 || obj.MinutesUntilReady is < 0 or > 1000000
            || mine.terrainFeatures.ContainsKey(tile) || mine.characters.Any(c => (int)c.Tile.X == x && (int)c.Tile.Y == y)
            || mine.doesTileHaveProperty(x, y, "Action", "Buildings") is not null || mine.doesTileHaveProperty(x, y, "TouchAction", "Back") is not null;
        foreach (var clump in clumps)
        {
            if (R.Get(clump, "netTile") is not Vector2 at || R.Get(clump, "width") is not int w || R.Get(clump, "height") is not int h
                || w is < 1 or > 64 || h is < 1 or > 64) { blocked = true; break; }
            if (x >= at.X && x < at.X + w && y >= at.Y && y < at.Y + h) { blocked = true; break; }
        }
        var target = MineActions.Key(obj);
        return new Rock(target, Digest(new { target, map = MineActions.Key(mine.Map), x, y, obj.QualifiedItemId, obj.Quality, obj.Stack, obj.MinutesUntilReady, blocked }),
            mine.NameOrUniqueName, x, y, obj.QualifiedItemId, obj.Quality, obj.MinutesUntilReady, blocked);
    }

    private static object Pickaxe(Pickaxe tool, int slot)
    {
        var enchantments = R.Items(R.Get(tool, "enchantments")).Take(33).ToArray();
        var nativeOnly = enchantments.Length <= 32 && enchantments.All(e => e.GetType().Assembly == typeof(Game1).Assembly);
        var entries = enchantments.Take(32).Select(e => new { type = e.GetType().FullName,
            level = e.GetType().Assembly == typeof(Game1).Assembly ? R.Plain(R.Get(e, "level")) : null }).ToArray();
        var power = R.Get(tool, "additionalPower"); var efficient = R.Get(tool, "isEfficient");
        var instance = MineActions.Key(tool);
        return new { slot, toolKey = instance, itemId = tool.QualifiedItemId, upgradeLevel = tool.UpgradeLevel,
            additionalPower = power, efficient, nativeEnchantmentsOnly = nativeOnly, enchantments = entries,
            damagePerSwing = power is int p && p is >= 0 and <= 64 && tool.UpgradeLevel is >= 0 and <= 4 ? (int?)(Math.Max(1, tool.UpgradeLevel + 1) + p) : null,
            // Charge zero Pickaxe.DoFunction costs <=2 stamina before native
            // efficiency/mining-level adjustments. This is a reserve, not final cost.
            energyCostAtQuery = efficient is true ? 0 : Math.Max(0, 2 - Game1.player.MiningLevel * 0.1f),
            // Mining buffs can expire between query and impact. Reserve the
            // unbuffed upper bound; permanent native efficiency is gear-bound.
            energyReservePerSwing = efficient is true ? 0 : 2, swingTicker = tool.swingTicker,
            gearDigest = Digest(new { instance, tool.QualifiedItemId, tool.UpgradeLevel, power, efficient, nativeOnly, entries }) };
    }

    private static object DebrisFact(Debris debris)
    {
        var type = R.Get(debris, "debrisType")?.ToString();
        var chunks = R.Items(R.Get(debris, "chunks")).Take(2049).Count();
        // Debris.item is a lazy getter which may materialize an Item. Only read
        // existing netItem/itemId and raw chunk count; never call collect/InitializeItem.
        var stored = R.Get(debris, "netItem") as Item;
        var storedKnown = stored is null || stored.GetType().Assembly == typeof(Game1).Assembly;
        return new { key = MineActions.Key(debris), type, chunks,
            classificationKnown = type is "CHUNKS" or "LETTERS" or "ARCHAEOLOGY" or "OBJECT" or "SPRITECHUNKS" or "RESOURCE" or "NUMBERS",
            collectible = type is "ARCHAEOLOGY" or "OBJECT" or "RESOURCE", itemId = R.Get(debris, "itemId"),
            storedItemKnown = storedKnown, storedItem = stored is null || !storedKnown ? null : new { itemId = stored.QualifiedItemId, quantity = stored.Stack, quality = stored.Quality },
            rawChunkType = R.Get(debris, "chunkType"), rawQuality = R.Get(debris, "netItemQuality") };
    }

    public static object Query(JsonElement args)
    {
        var state = MineActions.State();
        if (typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D") != Build || Game1.currentLocation.GetType() != typeof(MineShaft))
            return new { available = false, state, reason = "unsupported_build_or_not_native_mine_shaft" };
        var mine = (MineShaft)Game1.currentLocation; var layer = mine.Map.Layers[0];
        var objects = mine.Objects.Pairs.Take(16385).ToArray();
        var clumps = R.Items(R.Get(mine, "resourceClumps")).Take(257).ToArray();
        var debris = R.Items(R.Get(mine, "debris")).Take(2049).ToArray();
        if (objects.Length > 16384 || clumps.Length > 256 || clumps.Any(c => c.GetType() != typeof(ResourceClump)) || debris.Length > 2048 || layer.LayerWidth is < 1 or > 256 || layer.LayerHeight is < 1 or > 256)
            return new { available = false, state, reason = "mining_capture_exceeds_complete_bounds" };
        var rocks = objects.Select(pair => Stone(mine, pair.Key, pair.Value, clumps)).OfType<Rock>().OrderBy(r => r.Y).ThenBy(r => r.X).ToArray();
        var rockSetDigest = Digest(rocks.Select(r => new { r.TargetKey, r.X, r.Y, r.ItemId, r.Quality, r.Durability }));
        var radius = R.Int(args, "miningRadius", 24, 1, 64); var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 100, 1, 100);
        var nearby = rocks.Where(r => Math.Abs(r.X - Game1.player.Tile.X) + Math.Abs(r.Y - Game1.player.Tile.Y) <= radius)
            .OrderBy(r => Math.Abs(r.X - Game1.player.Tile.X) + Math.Abs(r.Y - Game1.player.Tile.Y)).ThenBy(r => r.Y).ThenBy(r => r.X).ToArray();
        object? target = null;
        if (args.TryGetProperty("position", out var position))
        {
            InventoryActions.Require(position.ValueKind == JsonValueKind.Object && R.Arg(position, "locationId") == mine.NameOrUniqueName, "Mining position must be in the current native mine");
            var x = R.Int(position, "x", -1, 0, layer.LayerWidth - 1); var y = R.Int(position, "y", -1, 0, layer.LayerHeight - 1);
            mine.Objects.TryGetValue(new Vector2(x, y), out var obj);
            target = new { position = new { locationId = mine.NameOrUniqueName, x, y }, empty = obj is null,
                objectKey = obj is null ? null : MineActions.Key(obj), rock = rocks.FirstOrDefault(r => r.X == x && r.Y == y) };
        }
        var tools = Game1.player.Items.Select((item, slot) => item?.GetType() == typeof(Pickaxe) ? Pickaxe((Pickaxe)item, slot) : null).Where(v => v is not null).ToArray();
        var nativeDebris = debris.OfType<Debris>().Where(d => d.GetType() == typeof(Debris)).Select(DebrisFact).ToArray();
        var xp = R.Items(R.Get(Game1.player, "experiencePoints")).Select(R.Unwrap).ToArray();
        return new { available = true, complete = true, state, rockSetDigest, rockCount = rocks.Length, nearbyCount = nearby.Length,
            offset, items = nearby.Skip(offset).Take(limit).ToArray(), nextOffset = offset + limit < nearby.Length ? offset + limit : (int?)null, target,
            pickaxes = tools, selectedSlot = Game1.player.CurrentToolIndex, usingTool = Game1.player.UsingTool,
            rocksCrushed = R.Get(Game1.player.stats, "RocksCrushed"), miningExperience = xp.Length > 3 ? xp[3] : null,
            stonesLeftOnLevel = R.Get(mine, "stonesLeftOnThisLevel"), mustKillAllMonsters = mine.mustKillAllMonstersToAdvance(),
            generatedLevel = MineShaft.IsGeneratedLevel(mine),
            debris = nativeDebris, debrisComplete = nativeDebris.Length == debris.Length && nativeDebris.All(d => R.Bool(d, "classificationKnown") && R.Bool(d, "storedItemKnown") && R.Number(d, "chunks") <= 2048),
            unsupportedObjectCount = objects.Count(p => p.Value.GetType() != typeof(SObject)),
            note = "Loaded ordinary single-tile breakable stones only; no clump mining, monster disguise or RNG/drop prediction. Durability is MinutesUntilReady, not player inventory. Existing/new debris disappearance does not prove pickup attribution." };
    }
}
