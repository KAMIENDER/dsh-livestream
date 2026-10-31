using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Owned food and normal native eating; never write health, stamina, buffs or eating flags.</summary>
internal static class FoodActions
{
    internal sealed record Vitals(int Health, int MaxHealth, float Energy, int MaxEnergy, int BaseMaxEnergy, bool Exhausted);
    internal sealed class Attempt
    {
        public SObject Source = null!;
        public string ItemId = "", Save = "", Day = "";
        public int Quality, Slot, MaxHealthLoss, MaxEnergyLoss;
        public GameLocation Location = null!;
        public InventoryActions.Count[] BeforeItems = Array.Empty<InventoryActions.Count>();
        public Vitals Before = null!;
        public object[] BeforeBuffs = Array.Empty<object>();
        public bool BeforeBuffsTruncated;
        public int BeforeGold;
    }
    internal static Vitals Player() => new(Game1.player.health, Game1.player.maxHealth, Game1.player.Stamina, Game1.player.MaxStamina,
        Game1.player.maxStamina.Value, Game1.player.exhausted.Value);
    private static bool SupportedBuild => typeof(Farmer).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    internal static object[] Buffs() => Game1.player.buffs.AppliedBuffs.OrderBy(row => row.Key).Take(128).Select(row => (object)new {
        id = row.Key, row.Value.displayName, row.Value.source, durationMs = row.Value.millisecondsDuration,
        totalDurationMs = row.Value.totalMillisecondsDuration, effects = R.Scalars(row.Value.effects),
    }).ToArray();
    private static bool IsDrink(SObject food) => Game1.objectData.TryGetValue(food.ItemId, out var data) && data.IsDrink;
    private static bool NoFoodRule() => Game1.player.team.SpecialOrderRuleActive("SC_NO_FOOD", null)
        && Game1.currentLocation is MineShaft mine && mine.getMineArea(-1) == 121;
    private static string[] Blocked(SObject? food = null)
    {
        var reasons = new List<string>();
        if (!SupportedBuild) reasons.Add("game_build_needs_eating_rule_audit");
        if (!Context.CanPlayerMove || Game1.player.UsingTool || Game1.player.isEating) reasons.Add("player_not_idle");
        if (Game1.activeClickableMenu is not null || Game1.eventUp || R.Get(typeof(Game1), "currentMinigame") is not null) reasons.Add("menu_event_or_minigame");
        if (Game1.fadeToBlack || R.Bool(typeof(Game1), "killScreen") || R.Bool(typeof(Game1), "dialogueUp")) reasons.Add("native_transition");
        if (Game1.player.health <= 0 || Game1.timeOfDay >= 2600) reasons.Add("dead_or_day_ending");
        if (Game1.player.isRidingHorse() || Game1.player.IsSitting() || R.Bool(Game1.player, "canOnlyWalk")
            || R.Bool(Game1.player, "bathingClothes") || R.Bool(Game1.player, "onBridge") || R.Bool(Game1.player.FarmerSprite, "PauseForSingleAnimation")) reasons.Add("native_pose_restriction");
        if (NoFoodRule()) reasons.Add("skull_cavern_no_food_challenge");
        if (food is not null)
        {
            if (food.GetType() != typeof(SObject) || !food.QualifiedItemId.StartsWith("(O)", StringComparison.Ordinal) || food.Stack <= 0 || food.Edibility == -300 || food.IsRecipe || food.questItem.Value) reasons.Add("not_plain_owned_edible");
            if (!Game1.objectData.ContainsKey(food.ItemId)) reasons.Add("food_data_unavailable");
            if (Game1.player.hasBuff("25") && !food.HasContextTag("ginger_item")) reasons.Add("nauseous");
            if (IsDrink(food) ? Game1.player.hasBuff("7") : Game1.player.hasBuff("6")) reasons.Add(IsDrink(food) ? "quenched" : "full");
        }
        return reasons.ToArray();
    }
    private static string Digest(SObject food, int slot) => GameFacts.Hash(JsonSerializer.Serialize(new {
        slot, food.QualifiedItemId, food.Quality, food.Stack, food.Edibility, drink = IsDrink(food), player = Player(),
        blocked = Blocked(food), location = Game1.currentLocation.NameOrUniqueName, date = GameFacts.DayKey(), inventory = InventoryActions.Digest(),
    }, LocalServer.Json));
    public static object Query(JsonElement args)
    {
        var slot = args.TryGetProperty("inventorySlot", out _) ? R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1) : -1;
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 30, 1, 100);
        var rows = Game1.player.Items.Select((item, index) => (item, index)).Where(row => (slot < 0 || row.index == slot) && row.item is SObject food && food.GetType() == typeof(SObject) && food.Edibility != -300).ToArray();
        return new { player = Player(), inventoryDigest = InventoryActions.Digest(), isEating = Game1.player.isEating,
            itemBeingEaten = Game1.player.itemToEat is SObject eating ? new { itemId = eating.QualifiedItemId, quality = eating.Quality } : null,
            buffs = Buffs(), buffsTruncated = Game1.player.buffs.AppliedBuffs.Count > 128, blocked = Blocked(),
            items = rows.Skip(offset).Take(limit).Select(row => {
                var food = (SObject)row.item!; var reasons = Blocked(food);
                Game1.objectData.TryGetValue(food.ItemId, out var data);
                return new { inventorySlot = row.index, itemId = food.QualifiedItemId, displayName = food.DisplayName, quality = food.Quality, count = food.Stack,
                    edibility = food.Edibility, isDrink = IsDrink(food),
                    nativeBaseEnergy = SupportedBuild ? (int?)food.staminaRecoveredOnConsumption() : null, nativeBaseHealth = SupportedBuild ? (int?)food.healthRecoveredOnConsumption() : null,
                    eligible = reasons.Length == 0, blocked = reasons, digest = Digest(food, row.index), negativeEdibilityNeedsExplicitConsent = food.Edibility < 0,
                    data = R.Fields(data, "Edibility", "IsDrink", "Buffs"), permanentStaminaItem = food.QualifiedItemId == "(O)434" };
            }).ToArray(), count = rows.Length, unsupportedObjectCount = Game1.player.Items.Count(item => item is SObject obj && obj.GetType() != typeof(SObject)),
            offset, nextOffset = offset + limit < rows.Length ? (int?)(offset + limit) : null,
            note = "Owned plain food/drink only; native base recovery is not a promise of final gain. Quality, caps, active buffs, special items and festival rules affect it. Buff durations are current observations, not a stable digest. No food/buff objects or random conditions are generated here." };
    }
    internal static Attempt Prepare(JsonElement args)
    {
        var slot = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1);
        var food = Game1.player.Items[slot] as SObject;
        InventoryActions.Require(food is not null && food.GetType() == typeof(SObject) && food.QualifiedItemId == R.Arg(args, "expectedItemId") && food.Quality == R.Int(args, "expectedQuality", -1, 0, 4), "Use the actual owned plain food slot/item/quality");
        InventoryActions.Require(Blocked(food).Length == 0, "Native eating/pose/challenge/food restrictions do not permit consumption");
        InventoryActions.Require(R.Arg(args, "foodDigest") == Digest(food!, slot) && R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "Food/player/inventory changed; requery before consuming");
        InventoryActions.Require(R.Int(args, "maxCount", 1, 1, 1) == 1, "One request consumes at most one owned food");
        var healthLoss = R.Int(args, "maxHealthLoss", 0, 0, 1000); var energyLoss = R.Int(args, "maxEnergyLoss", 0, 0, 5000);
        var allowNegative = args.TryGetProperty("allowNegativeEdibility", out var allow) && allow.GetBoolean();
        InventoryActions.Require(food!.Edibility >= 0 || allowNegative, "Negative-edibility food needs explicit permission");
        InventoryActions.Require(energyLoss >= Math.Max(0, -food.staminaRecoveredOnConsumption()), "Reserve the possible native base energy loss before eating");
        var attempt = new Attempt { Source = food, Slot = slot, ItemId = food.QualifiedItemId, Quality = food.Quality, Save = GameFacts.SaveId(), Day = GameFacts.DayKey(),
            Location = Game1.currentLocation, Before = Player(), BeforeBuffs = Buffs(), BeforeBuffsTruncated = Game1.player.buffs.AppliedBuffs.Count > 128,
            BeforeGold = Game1.player.Money, BeforeItems = InventoryActions.Counts(), MaxHealthLoss = healthLoss, MaxEnergyLoss = energyLoss };
        Game1.player.CurrentToolIndex = slot;
        InventoryActions.Require(ReferenceEquals(Game1.player.ActiveObject, food), "Native selected food was not confirmed");
        return attempt;
    }
    internal static bool Begin(Attempt food)
    {
        // showCarrying binds mostRecentlyGrabbedItem to the actual selected source.
        // Stardrops start eating there automatically. Never invoke a second eat for it.
        Game1.player.showCarrying();
        if (!Game1.player.isEating)
        {
            if (!ReferenceEquals(Game1.player.mostRecentlyGrabbedItem, food.Source)) throw new InvalidOperationException("Native held-food binding was not established");
            // Same public native handler used by Eat_Yes. overrideFullness stays false
            // inside eatHeldObject, and the outer native challenge/pose gates were checked.
            Game1.player.eatHeldObject();
        }
        return Game1.player.isEating;
    }
    internal static object Finish(Attempt food, bool rejected = false)
    {
        var after = Player(); var changes = InventoryActions.Changes(food.BeforeItems);
        var context = food.Save == GameFacts.SaveId() && food.Day == GameFacts.DayKey() && ReferenceEquals(food.Location, Game1.currentLocation) && !Game1.eventUp;
        var costs = changes.Length == 1 && changes[0].ItemId == food.ItemId && changes[0].Quality == food.Quality && changes[0].Amount == -1 && Game1.player.Money == food.BeforeGold;
        var losses = food.Before.Health - after.Health <= food.MaxHealthLoss && food.Before.Energy - after.Energy <= food.MaxEnergyLoss + .001f;
        var idle = !Game1.player.isEating && !Game1.player.UsingTool && Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.fadeToBlack && !R.Bool(Game1.player.FarmerSprite, "PauseForSingleAnimation");
        var waitingStardrop = food.ItemId == "(O)434" && !Game1.player.isEating && after.BaseMaxEnergy == food.Before.BaseMaxEnergy + 34 && Game1.activeClickableMenu is not null;
        var confirmed = context && costs && losses && (idle || waitingStardrop);
        var knownRejection = rejected && context && changes.Length == 0 && Game1.player.Money == food.BeforeGold && after == food.Before && !Game1.player.isEating;
        return new { confirmedConsumption = confirmed, completedWorkflow = confirmed && idle, outcome = confirmed ? idle ? "consumed" : "consumed_waiting_ui" : knownRejection ? "rejected" : "unconfirmed",
            completionUncertain = !confirmed && !knownRejection, foodItemId = food.ItemId, quality = food.Quality, consumedCount = confirmed ? 1 : 0,
            beforePlayer = food.Before, afterPlayer = after, beforeBuffs = food.BeforeBuffs, beforeBuffsTruncated = food.BeforeBuffsTruncated,
            afterBuffs = Buffs(), buffsTruncated = Game1.player.buffs.AppliedBuffs.Count > 128,
            beforeGold = food.BeforeGold, afterGold = Game1.player.Money, inventoryChanges = changes,
            menuType = Game1.activeClickableMenu?.GetType().FullName, nativeIdle = idle,
            note = "Normal owned-food consumption; actual native recovery/buff replacement only. Clamping can make gains zero. Stardrop special UI remains waiting; no forced close, synthetic success, healing or retry." };
    }
}
