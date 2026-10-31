using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.Tools;

namespace DshStardew;

internal sealed class GameFacts
{
    private readonly IModHelper helper;
    private static string cachedSavePath = "";
    private static long cachedSaveStamp;
    private static long cachedSaveLength;
    private static string cachedSaveHash = "";
    public GameFacts(IModHelper helper) => this.helper = helper;
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static object Date() => new { year = Game1.year, season = Game1.currentSeason, dayOfMonth = Game1.dayOfMonth };
    public static string DayKey() => $"{Game1.year}/{Game1.currentSeason}/{Game1.dayOfMonth}";

    public static object[] Inventory() => Game1.player.Items.Select((item, slot) => (object)new {
        slot, id = item?.QualifiedItemId, count = item?.Stack ?? 0,
        quality = item is StardewValley.Object obj ? obj.Quality : 0,
        toolUpgrade = item is Tool tool ? (int?)tool.UpgradeLevel : null,
        attachments = item is Tool attached ? R.Describe(R.Get(attached, "attachments")) : null,
    }).ToArray();

    public static string SaveId()
    {
        // A copied save in another folder must never inherit this farm's memory or run budget.
        var path = Constants.CurrentSavePath ?? throw new InvalidOperationException("Save path is unavailable; save the new farm first.");
        return Hash($"{Path.GetFullPath(path)}|{Game1.uniqueIDForThisGame}|{Game1.player.UniqueMultiplayerID}");
    }

    public static object Identity() => new {
        saveId = SaveId(), playerId = Game1.player.UniqueMultiplayerID.ToString(),
        gameId = Game1.uniqueIDForThisGame.ToString(), saveFolder = Constants.SaveFolderName,
        gameVersion = Game1.version,
        gameAssemblyVersion = typeof(Game1).Assembly.GetName().Version?.ToString(),
        gameBuildId = typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D"),
        date = Date(),
        controlDigest = Hash(JsonSerializer.Serialize(new {
            date = Date(), location = Game1.currentLocation.NameOrUniqueName,
            tile = R.Plain(Game1.player.Tile), money = Game1.player.Money,
            health = Game1.player.health, energy = Game1.player.Stamina, inventory = Inventory(),
            facing = Game1.player.FacingDirection, selectedSlot = R.Get(Game1.player, "CurrentToolIndex"),
            lastDiskSave = DiskSaveHash(),
        })),
    };

    private static string DiskSaveHash()
    {
        var folder = Constants.CurrentSavePath ?? throw new InvalidOperationException("Save once before using persistent control");
        var path = Path.Combine(folder, new DirectoryInfo(folder).Name);
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > 64_000_000) throw new InvalidOperationException("Cannot bind the on-disk save identity");
        if (cachedSavePath != path || cachedSaveStamp != file.LastWriteTimeUtc.Ticks || cachedSaveLength != file.Length)
        {
            cachedSaveHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
            cachedSavePath = path; cachedSaveStamp = file.LastWriteTimeUtc.Ticks; cachedSaveLength = file.Length;
        }
        return cachedSaveHash;
    }

    public static object ControlState() => new {
        date = Date(), time = Game1.timeOfDay, location = Game1.currentLocation.NameOrUniqueName,
        tile = R.Plain(Game1.player.Tile), facing = Game1.player.FacingDirection,
        selectedSlot = R.Get(Game1.player, "CurrentToolIndex"),
        energy = Game1.player.Stamina, health = Game1.player.health, money = Game1.player.Money,
        usingTool = Game1.player.UsingTool, menu = Game1.activeClickableMenu?.GetType().Name,
        minigame = R.Get(typeof(Game1), "currentMinigame")?.GetType().Name,
        eventUp = Game1.eventUp, inventory = Inventory(),
    };

    private static IEnumerable<GameLocation> Locations()
    {
        var queue = new Queue<GameLocation>(Game1.locations);
        queue.Enqueue(Game1.currentLocation);
        var seen = new HashSet<GameLocation>();
        while (queue.Count > 0 && seen.Count < 512)
        {
            var location = queue.Dequeue();
            if (!seen.Add(location)) continue;
            yield return location;
            foreach (var building in R.Items(R.Get(location, "buildings")))
                if (R.Get(building, "indoors") is GameLocation indoors) queue.Enqueue(indoors);
        }
    }

    public object Progress(JsonElement args)
    {
        var player = Game1.player;
        var section = R.Arg(args, "section", "overview");
        if (section == "overview") return new {
            identity = Identity(), state = ControlState(),
            skills = R.Fields(player, "farmingLevel", "miningLevel", "fishingLevel", "foragingLevel", "combatLevel", "luckLevel", "experiencePoints", "professions", "deepestMineLevel", "netDeepestMineLevel", "houseUpgradeLevel", "spouse"),
            availableSections = new[] { "quests", "friendships", "recipes", "cooking", "collections", "mail", "events", "achievements", "community", "stats", "special_orders" },
        };
        IEnumerable<object> rows = section switch {
            // These public display getters lazily generate quest descriptions/objectives.
            // A read must not do that work: expose only already-loaded cached text here.
            "quests" => R.Items(R.Get(player, "questLog")).Select(q => (object)new {
                id = R.Get(q, "id"), questTitle = R.Get(q, "_questTitle"), questDescription = R.Get(q, "_questDescription"), currentObjective = R.Get(q, "_currentObjective"),
                accepted = R.Get(q, "accepted"), completed = R.Get(q, "completed"), dailyQuest = R.Get(q, "dailyQuest"),
                daysLeft = R.Get(q, "daysLeft"), moneyReward = R.Get(q, "moneyReward"), questType = R.Get(q, "questType"), displayTextSource = "loaded_cache_only",
            }),
            "friendships" => Pairs(R.Get(player, "friendshipData"), v => R.Fields(v, "Points", "Status", "GiftsThisWeek", "GiftsToday", "TalkedToToday", "LastGiftDate", "WeddingDate", "DaysMarried", "RoommateMarriage")),
            "recipes" => Pairs(R.Get(player, "craftingRecipes")),
            "cooking" => Pairs(R.Get(player, "cookingRecipes")),
            "collections" => new[] { "basicShipped", "mineralsFound", "recipesCooked", "fishCaught", "archaeologyFound" }.SelectMany(name => Pairs(R.Get(player, name)).Select(row => (object)new { collection = name, entry = row })),
            "mail" => new[] { "mailReceived", "mailForTomorrow", "mailbox" }.SelectMany(name => R.Items(R.Get(player, name)).Select(value => (object)new { source = name, value = R.Plain(value) })),
            "events" => R.Items(R.Get(player, "eventsSeen")).Select(value => R.Plain(value)!),
            "achievements" => R.Items(R.Get(player, "achievements")).Select(value => R.Plain(value)!),
            "stats" => R.Fields(R.Get(player, "stats"), "DaysPlayed", "StepsTaken", "MonstersKilled", "ItemsShipped", "SeedsSown", "CropsShipped", "FishCaught").Select(pair => (object)new { key = pair.Key, value = pair.Value }),
            "community" => Community(),
            "special_orders" => R.Items(R.Get(R.Get(player, "team"), "specialOrders")).Select(order => (object)R.Fields(order, "questKey", "questName", "questDescription", "questState", "objectives", "dueDate", "rewards")),
            _ => throw new ArgumentException("Unknown progress section"),
        };
        return Page(rows, args);
    }

    private static IEnumerable<object> Community()
    {
        var world = R.Get(typeof(Game1), "netWorldState");
        yield return new { source = "world", data = R.Fields(world, "Bundles", "BundleRewards") };
        foreach (var location in Locations().Where(l => l.GetType().Name == "CommunityCenter"))
            yield return new { source = location.NameOrUniqueName, data = R.Fields(location, "areasComplete", "bundles", "bundleRewards") };
    }

    public object Social(JsonElement args)
    {
        var name = R.Arg(args, "name");
        var rows = Locations().SelectMany(l => l.characters).OfType<NPC>()
            .GroupBy(n => n.Name).Select(group => group.First())
            .Where(n => name.Length == 0 || n.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            .OrderBy(n => n.Name).Select(n => (object)new {
                name = n.Name, displayName = n.displayName,
                location = n.currentLocation?.NameOrUniqueName, tile = R.Plain(n.Tile),
                details = R.Fields(n, "Birthday_Season", "Birthday_Day", "IsVillager", "ScheduleKey", "dayScheduleName", "islandScheduleName"),
                schedule = Pairs(R.Get(n, "Schedule"), entry => new { known = R.Fields(entry, "targetLocation", "targetTile", "targetFacingDirection", "endOfRouteBehavior", "endOfRouteMessage"), descriptor = R.Describe(entry) }).ToArray(),
            });
        return Page(rows, args, "Currently loaded NPC instances and today's loaded schedule; missing entries are unknown, not absent.");
    }

    public object Farm(JsonElement args)
    {
        var section = R.Arg(args, "section", "animals");
        var animalId = R.Arg(args, "animalId"); var locationId = R.Arg(args, "locationId");
        if (animalId.Length > 0 && section != "animals") throw new ArgumentException("animalId is only valid for the animals section");
        var locations = Locations().Where(l => locationId.Length == 0 || l.NameOrUniqueName == locationId);
        IEnumerable<object> rows = section switch {
            "animals" => locations.SelectMany(l => AnimalCare.In(l).Where(animal => animalId.Length == 0 || AnimalCare.Id(animal) == animalId).Select(animal => (object)new {
                location = l.NameOrUniqueName,
                animalId = AnimalCare.Id(animal), facts = AnimalCare.Project(animal, l),
                data = R.Fields(animal, "myID", "Name", "displayName", "type", "Tile", "age", "health", "friendshipTowardFarmer", "happiness", "fullness", "wasPet", "wasAutoPet", "currentProduce", "produceQuality", "allowReproduction", "ownerID"),
            })),
            "buildings" => locations.SelectMany(l => R.Items(R.Get(l, "buildings")).Select(b => (object)new {
                location = l.NameOrUniqueName,
                data = R.Fields(b, "id", "buildingType", "tileX", "tileY", "tilesWide", "tilesHigh", "daysOfConstructionLeft", "daysUntilUpgrade", "animalDoorOpen", "maxOccupants", "currentOccupants", "humanDoor", "animalDoor", "owner"),
                indoors = (R.Get(b, "indoors") as GameLocation)?.NameOrUniqueName,
            })),
            "machines" => locations.SelectMany(l => Pairs(R.Get(l, "Objects"), value => R.Fields(value, "QualifiedItemId", "DisplayName", "readyForHarvest", "MinutesUntilReady", "minutesUntilReady", "heldObject", "Stack")).Select(row => (object)new { location = l.NameOrUniqueName, entry = row })),
            "locations" => locations.Select(l => (object)new {
                id = l.NameOrUniqueName, type = l.GetType().Name,
                warps = R.Items(R.Get(l, "warps")).Select(w => R.Fields(w, "X", "Y", "TargetName", "TargetX", "TargetY")).ToArray(),
                map = R.Fields(R.Get(l, "Map"), "DisplayWidth", "DisplayHeight"),
            }),
            _ => throw new ArgumentException("section must be animals/buildings/machines/locations"),
        };
        return Page(rows, args, "Loaded locations and building interiors only. Use native interactions/UI for petting, feeding, purchases, upgrades and placement.");
    }

    public object Mine(JsonElement args)
    {
        var location = Game1.currentLocation;
        var radius = R.Int(args, "radius", 8, 1, 12);
        var x = (int)Game1.player.Tile.X;
        var y = (int)Game1.player.Tile.Y;
        var exits = new List<object>();
        for (var tx = Math.Max(0, x - radius); tx <= x + radius; tx++)
        for (var ty = Math.Max(0, y - radius); ty <= y + radius; ty++)
        {
            var action = location.doesTileHaveProperty(tx, ty, "Action", "Buildings");
            var touch = location.doesTileHaveProperty(tx, ty, "TouchAction", "Back");
            if (action is not null || touch is not null) exits.Add(new { x = tx, y = ty, action, touchAction = touch });
        }
        return new {
            location = location.NameOrUniqueName, type = location.GetType().Name,
            mine = R.Fields(location, "mineLevel", "isMonsterArea", "isSlimeArea", "isDinoArea", "mustKillAllMonstersToAdvance", "ladderHasSpawned", "netIsTreasureRoom"),
            monsters = location.characters.OfType<Monster>().Select(MonsterFact).ToArray(),
            nearbyMapActions = exits,
            travel = MineActions.Query(),
            mining = MiningFacts.Query(args),
            warning = "Map actions are reported literally; no ladder creation, warping, invulnerability or guaranteed safe path.",
        };
    }

    public static object MonsterFact(Monster monster) => new {
        name = monster.Name, type = monster.GetType().Name, tile = R.Plain(monster.Tile),
        data = R.Fields(monster, "Health", "MaxHealth", "DamageToFarmer", "resilience", "isInvincible", "invincibleCountdown"),
    };

    public object Event() => new {
        eventUp = Game1.eventUp, festival = Game1.isFestival(),
        currentEvent = R.Fields(R.Get(Game1.currentLocation, "currentEvent"), "id", "isFestival", "CurrentCommand", "festivalHost", "festivalTimer", "festivalProps"),
        minigame = R.Get(typeof(Game1), "currentMinigame") is { } game ? new { type = game.GetType().FullName, state = R.Scalars(game) } : null,
        fishingRod = Game1.player.CurrentTool is FishingRod rod ? R.Fields(rod, "isFishing", "isNibbling", "isTimingCast", "castingPower", "isReeling", "fishCaught", "whichFish", "fishQuality", "showingTreasure") : null,
        bobberBar = Game1.activeClickableMenu?.GetType().Name == "BobberBar"
            ? R.Fields(Game1.activeClickableMenu, "bobberPosition", "bobberBarPos", "bobberBarHeight", "bobberBarSpeed", "distanceFromCatching", "treasure", "treasureCaught", "fadeIn", "fadeOut") : null,
    };

    // These are the running game's loaded assets, including installed content mods, not a hard-coded wiki.
    private static readonly Dictionary<string, string> StaticAssets = new() {
        ["objects"] = "objectData", ["big_craftables"] = "bigCraftableData", ["crops"] = "cropData",
        ["fruit_trees"] = "fruitTreeData", ["weapons"] = "weaponData", ["tools"] = "toolData",
        ["buildings"] = "buildingData", ["animals"] = "farmAnimalData", ["characters"] = "characterData", ["locations"] = "locationData",
    };
    private static readonly Dictionary<string, string> StringAssets = new() {
        ["fish"] = "Data/Fish", ["quests"] = "Data/Quests", ["bundles"] = "Data/Bundles",
        ["gift_tastes"] = "Data/NPCGiftTastes", ["achievements"] = "Data/Achievements", ["festivals"] = "Data/Festivals/FestivalDates",
    };

    public object Catalog(JsonElement args)
    {
        var section = R.Arg(args, "section", "objects");
        var search = R.Arg(args, "search");
        object? data;
        if (StaticAssets.TryGetValue(section, out var field)) data = R.Get(typeof(Game1), field);
        else if (StringAssets.TryGetValue(section, out var asset)) data = helper.GameContent.Load<Dictionary<string, string>>(asset);
        else if (section == "machines") data = helper.GameContent.Load<Dictionary<string, StardewValley.GameData.Machines.MachineData>>("Data/Machines");
        else if (section == "crafting" || section == "cooking") data = R.Get(typeof(CraftingRecipe), section == "crafting" ? "craftingRecipes" : "cookingRecipes");
        else throw new ArgumentException("Unknown catalog section");
        if (data is null) throw new InvalidOperationException("Asset is not loaded; no empty-success fallback.");
        var rows = R.Items(data).OrderBy(e => Convert.ToString(R.Raw(e, "Key")), StringComparer.Ordinal)
            .Select(e => new { key = Convert.ToString(R.Raw(e, "Key")), value = JsonSerializer.SerializeToElement(R.Raw(e, "Value"), LocalServer.Json) })
            .Where(e => search.Length == 0 || (e.key ?? "").Contains(search, StringComparison.OrdinalIgnoreCase)
                || e.value.GetRawText().Contains(search, StringComparison.OrdinalIgnoreCase));
        return Page(rows.Cast<object>(), args, "Actual game assets. Raw recipe/condition strings require interpretation; availability and current shop prices must still be observed.");
    }

    private static IEnumerable<object> Pairs(object? data, Func<object?, object?>? project = null) => R.Items(data).Select(pair => (object)new {
        key = R.Plain(R.Raw(pair, "Key")), value = project is null ? R.Describe(R.Raw(pair, "Value")) : project(R.Raw(pair, "Value")),
    });

    private static object Page(IEnumerable<object> rows, JsonElement args, string? note = null)
    {
        var offset = R.Int(args, "offset", 0, 0, 100000);
        var limit = R.Int(args, "limit", 30, 1, 100);
        var page = rows.Skip(offset).Take(limit + 1).ToArray();
        return new { observedAt = DateTimeOffset.UtcNow, date = Date(), offset, items = page.Take(limit).ToArray(), nextOffset = page.Length > limit ? (int?)(offset + limit) : null,
            coverage = "selected_section_page", nestedProjection = new { maxDepth = 3, maxEntries = 128, complete = false },
            missingFields = "null means unavailable, never false or zero", note };
    }
}
