using System.Text.Json;
using System.Reflection;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>One native melee action against a pinned monster; damage and death are separate observations.</summary>
internal static class MeleeActions
{
    private const string Build = "e2d77e0c-417e-41ec-b5ab-ab6e915ce317";
    private static bool Supported() => typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D") == Build;
    private static string Hash(object value) => GameFacts.Hash(JsonSerializer.Serialize(value, LocalServer.Json));
    private static bool Native(Monster m) => m.GetType().Assembly == typeof(Game1).Assembly;
    internal sealed record Life(int? DeathAnimationCounter, int? MummyReviveTimerMs);
    private static readonly FieldInfo? DeathEvent = typeof(Monster).GetField("deathAnimEvent", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
    internal static Life Lifecycle(Monster m)
    {
        if (!Supported() || !Native(m)) return new(null, null);
        // Read the exact base field, not a same-named subtype member. NetEvent0
        // Fire increments Counter before its normal Poll; Poll does not erase
        // Counter. Never Fire/Poll/Clear, subscribe handlers or write the event.
        var signal = DeathEvent?.GetValue(m);
        var count = signal?.GetType().FullName == "Netcode.NetEvent0" && signal.GetType().Assembly == typeof(Game1).Assembly
            && R.Get(signal, "Counter") is int value && value >= 0 ? (int?)value : null;
        return new(count, m.GetType() == typeof(Mummy) && R.Get(m, "reviveTimer") is int timer ? timer : null);
    }
    private static bool Attackable(Monster m) => m.Health > 0 && (m.GetType() != typeof(Mummy) || Lifecycle(m).MummyReviveTimerMs is <= 0);
    internal static string? DeathRule(Monster m, Life before, long globalKills, bool present)
    {
        if (present || m.Health > 0 || globalKills <= 0 || !Native(m)) return null;
        var after = Lifecycle(m);
        if (before.DeathAnimationCounter is not int start || after.DeathAnimationCounter is not int end || end < start) return null;
        // Exact-build Mummy.takeDamage resets HP to MaxHealth and starts a
        // 10000ms reviveTimer on ordinary collapse. Only its terminal path
        // leaves nonpositive HP for onMonsterKilled to count/remove; that path
        // need not fire deathAnimEvent. A collapse event alone proves nothing.
        if (m.GetType() == typeof(Mummy) && before.MummyReviveTimerMs is not null && after.MummyReviveTimerMs is not null)
            return "native_mummy_terminal_removal";
        return (long)end - start == 1 ? "native_death_event_and_terminal_removal" : null;
    }
    private static int Type(MeleeWeapon w) => (int)R.Number(w, "type");
    private static string Family(MeleeWeapon w)
    {
        var type = Type(w);
        foreach (var pair in new[] { ("stabbingSword", "stabbing_sword"), ("dagger", "dagger"), ("club", "club"), ("defenseSword", "defense_sword") })
            if (type == (int)R.Number(typeof(MeleeWeapon), pair.Item1)) return pair.Item2;
        return "unknown";
    }
    // Exact inspected specialCooldown switch; never invoke the protected method
    // through reflection or reset the game's timers to make a move available.
    private static int Cooldown(MeleeWeapon w) => Type(w) switch {
        0 => MeleeWeapon.defenseCooldown, 1 => MeleeWeapon.daggerCooldown,
        2 => MeleeWeapon.clubCooldown, 3 => MeleeWeapon.attackSwordCooldown, _ => -1,
    };
    private static object Weapon(MeleeWeapon w, int slot)
    {
        var enchants = R.Items(R.Get(w, "enchantments")).Take(33).ToArray();
        var native = enchants.Length <= 32 && enchants.All(e => e.GetType().Assembly == typeof(Game1).Assembly);
        var entries = enchants.Take(32).Select(e => new { type = e.GetType().FullName,
            level = e.GetType().Assembly == typeof(Game1).Assembly ? R.Plain(R.Get(e, "level")) : null }).ToArray();
        var stats = R.Fields(w, "type", "minDamage", "maxDamage", "speed", "addedPrecision", "addedDefense", "addedAreaOfEffect", "knockback", "critChance", "critMultiplier");
        var weaponKey = MineActions.Key(w); var family = Family(w);
        return new { slot, weaponKey, itemId = w.QualifiedItemId, family, scythe = w.isScythe(), nativeEnchantmentsOnly = native,
            stats, enchantments = entries, specialCooldownMs = Cooldown(w), w.isOnSpecial,
            gearDigest = Hash(new { weaponKey, w.QualifiedItemId, family, stats, entries, native }) };
    }
    private static string Gear(MeleeWeapon w, int slot) => R.Text(Weapon(w, slot), "gearDigest");
    internal static object MonsterFact(Monster m) => new { targetKey = MineActions.Key(m), type = m.GetType().FullName, native = Native(m),
        health = m.Health, maxHealth = m.MaxHealth, invincibleCountdown = R.Get(m, "invincibleCountdown"),
        contactDamage = m.DamageToFarmer, resilience = R.Get(m, "resilience"),
        lifecycle = Lifecycle(m), meleeTargetReady = Native(m) && Attackable(m),
        position = new { locationId = Game1.currentLocation.NameOrUniqueName, x = (int)m.Tile.X, y = (int)m.Tile.Y },
        bounds = Native(m) ? R.Plain(m.GetBoundingBox()) : null };
    private static double Range(JsonElement args, string name, double fallback, double min, double max)
    {
        var value = fallback;
        if (args.TryGetProperty(name, out var node))
            InventoryActions.Require(node.ValueKind == JsonValueKind.Number && node.TryGetDouble(out value), $"{name} must be a number");
        InventoryActions.Require(double.IsFinite(value) && value >= min && value <= max, $"{name} is outside its bounded range");
        return value;
    }
    // The public special entry assumes Game1's input-dispatch pose checks. Keep
    // those preconditions here; direct entry must not bypass bridge/walk-only,
    // bathing/swimming, farm events, dialogue, chat or minigames. Exact-build
    // field reads must be false, not merely absent/unrecognized.
    internal static bool PoseReady() => Supported() && Context.IsWorldReady && Context.IsMainPlayer && !Context.IsMultiplayer
        && R.Get(Game1.player, "canOnlyWalk") is false && R.Get(Game1.player, "onBridge") is false
        && R.Get(Game1.player, "bathingClothes") is false && R.Get(Game1.player, "swimming") is false
        && R.Get(typeof(Game1), "farmEvent") is null && R.Get(typeof(Game1), "currentMinigame") is null
        && R.Get(typeof(Game1), "dialogueUp") is false && R.Get(typeof(Game1), "IsChatting") is false;
    private static bool Idle(MeleeWeapon w) => PoseReady() && Context.CanPlayerMove && !Game1.player.UsingTool && Game1.player.CanMove
        && !Game1.player.FarmerSprite.PauseForSingleAnimation && !w.isOnSpecial && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.fadeToBlack;

    public static object Query()
    {
        var state = MineActions.State();
        if (!Supported()) return new { available = false, state, reason = "unsupported_combat_build" };
        var monsters = Game1.currentLocation.characters.OfType<Monster>().Take(129).ToArray();
        if (monsters.Length > 128 || Game1.player.Items.Count > 256) return new { available = false, state, reason = "combat_capture_exceeds_complete_bounds" };
        var weapons = Game1.player.Items.Select((item, slot) => item?.GetType() == typeof(MeleeWeapon) ? Weapon((MeleeWeapon)item, slot) : null).Where(w => w is not null).ToArray();
        return new { available = true, complete = true, state, poseReady = PoseReady(), selectedSlot = Game1.player.CurrentToolIndex,
            usingTool = Game1.player.UsingTool, pauseForAnimation = Game1.player.FarmerSprite.PauseForSingleAnimation,
            weapons, monsters = monsters.Select(MonsterFact).ToArray(), monstersKilled = Game1.player.stats.MonstersKilled,
            note = "Native loaded monster instances and melee weapons only. Passive death-event counters, terminal removal and the inspected mummy lifecycle are separate from damage/loot causality. Native weapon AOE may affect nearby monsters/terrain; no automatic loot collection or guaranteed safe path." };
    }

    internal sealed class Attempt
    {
        public GameLocation Location = null!;
        public Monster Target = null!;
        public MeleeWeapon Weapon = null!;
        public string Save = "", Day = "", Mode = "", Gear = "", InventoryDigest = "", TargetType = "";
        public int Slot, Health, LastHealth, HealthFloor, MaxHealthLoss, ObservedHealthLoss, Money, TargetHealth, BeforeCooldown;
        public uint Killed;
        public float Energy;
        public double MaxRange, MaxDisplacement;
        public Vector2 Start;
        public bool Submitted, Accepted, SawSpecial;
        public int StableTicks;
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public Dictionary<string, (Monster Monster, int Health)> Monsters = new();
        public object Before = null!;
        public Life TargetLife = new(null, null);
        public Dictionary<string, Life> Lives = new();
    }
    public static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(Supported() && Context.IsWorldReady && Context.IsMainPlayer && !Context.IsMultiplayer
            && Context.CanPlayerMove && !Game1.player.UsingTool && Game1.activeClickableMenu is null
            && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null, "Melee requires an idle native single-player world");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object, "Melee arguments must be an object");
        InventoryActions.Require(args.EnumerateObject().All(p => new[] { "mode", "locationKey", "targetKey", "expectedTargetType", "expectedDeathAnimationCounter", "weaponSlot", "weaponKey", "expectedWeaponItemId", "gearDigest", "inventoryDigest", "expectedHealth", "expectedMoney", "healthFloor", "maxHealthLoss", "maxRangeTiles", "maxDisplacementTiles", "durationMs" }.Contains(p.Name)), "Unknown melee argument");
        var slot = R.Int(args, "weaponSlot", -1, 0, Game1.player.Items.Count - 1);
        InventoryActions.Require(Game1.player.Items[slot]?.GetType() == typeof(MeleeWeapon) && Game1.player.CurrentToolIndex == slot
            && ReferenceEquals(Game1.player.CurrentTool, Game1.player.Items[slot]), "Equip the exact owned melee weapon first");
        var weapon = (MeleeWeapon)Game1.player.Items[slot];
        var descriptor = Weapon(weapon, slot);
        InventoryActions.Require(!weapon.isScythe() && Family(weapon) != "unknown" && R.Bool(descriptor, "nativeEnchantmentsOnly") && Idle(weapon)
            && MineActions.Key(weapon) == R.Arg(args, "weaponKey") && weapon.QualifiedItemId == R.Arg(args, "expectedWeaponItemId")
            && Gear(weapon, slot) == R.Arg(args, "gearDigest"), "Native weapon identity, family, enchantments or idle state changed");
        var monsters = Game1.currentLocation.characters.OfType<Monster>().Take(129).ToArray();
        InventoryActions.Require(monsters.Length <= 128 && monsters.All(Native), "Unrecognized/custom monster or incomplete combat roster");
        var target = monsters.SingleOrDefault(m => MineActions.Key(m) == R.Arg(args, "targetKey"));
        InventoryActions.Require(target is not null && Attackable(target) && Lifecycle(target).DeathAnimationCounter is not null && target.GetType().FullName == R.Arg(args, "expectedTargetType")
            && MineActions.Key(Game1.currentLocation) == R.Arg(args, "locationKey"), "Exact current native monster or location changed");
        InventoryActions.Require(Lifecycle(target!).DeathAnimationCounter == R.Int(args, "expectedDeathAnimationCounter", -1, 0, int.MaxValue), "Pinned monster lifecycle changed");
        var mode = R.Arg(args, "mode"); InventoryActions.Require(mode is "attack" or "special", "One normal attack or native special only");
        InventoryActions.Require(mode != "special" || Cooldown(weapon) <= 0, "Native special is still cooling down");
        var a = new Attempt { Location = Game1.currentLocation, Target = target!, TargetType = target!.GetType().FullName!, Weapon = weapon,
            Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), Mode = mode, Slot = slot, Gear = Gear(weapon, slot),
            InventoryDigest = InventoryActions.Digest(), Inventory = InventoryActions.Counts(), Money = Game1.player.Money,
            Health = Game1.player.health, LastHealth = Game1.player.health, HealthFloor = R.Int(args, "healthFloor", 30, 1, 1000),
            MaxHealthLoss = R.Int(args, "maxHealthLoss", 0, 0, 1000), Energy = Game1.player.Stamina, Killed = Game1.player.stats.MonstersKilled,
            TargetHealth = target.Health, BeforeCooldown = Cooldown(weapon), Start = Game1.player.Tile,
            MaxRange = Range(args, "maxRangeTiles", 2.5, 0.5, 4), MaxDisplacement = Range(args, "maxDisplacementTiles", 3, 0, 8),
            Monsters = monsters.ToDictionary(m => MineActions.Key(m), m => (m, m.Health)),
            TargetLife = Lifecycle(target), Lives = monsters.ToDictionary(m => MineActions.Key(m), Lifecycle), Before = Query() };
        InventoryActions.Require(a.Health == R.Int(args, "expectedHealth", -1, 1, 1000) && a.Money == R.Int(args, "expectedMoney", -1, 0, int.MaxValue)
            && a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.Health >= a.HealthFloor, "Observed inventory, health, gold or health floor changed");
        InventoryActions.Require(Vector2.Distance(a.Target.Tile, Game1.player.Tile) <= a.MaxRange, "Pinned target is outside the approved melee range");
        return a;
    }

    internal static bool ContextMatches(Attempt a) => Context.IsWorldReady && Context.IsMainPlayer && !Context.IsMultiplayer
        && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day && ReferenceEquals(Game1.currentLocation, a.Location)
        && Game1.player.CurrentToolIndex == a.Slot && ReferenceEquals(Game1.player.CurrentTool, a.Weapon) && Gear(a.Weapon, a.Slot) == a.Gear;
    internal static bool BeforeInput(Attempt a) => ContextMatches(a) && Idle(a.Weapon) && a.Location.characters.Contains(a.Target)
        && Attackable(a.Target) && Lifecycle(a.Target).DeathAnimationCounter == a.TargetLife.DeathAnimationCounter
        && InventoryActions.Digest() == a.InventoryDigest && Game1.player.Money == a.Money
        && a.Location.characters.OfType<Monster>().Take(129).Count() <= 128 && a.Location.characters.OfType<Monster>().All(Native)
        && (a.Mode != "special" || Cooldown(a.Weapon) <= 0 && Cooldown(a.Weapon) == a.BeforeCooldown)
        && Vector2.Distance(a.Target.Tile, Game1.player.Tile) <= a.MaxRange && Game1.timeOfDay < 2200;
    internal static void Begin(Attempt a)
    {
        var delta = a.Target.GetBoundingBox().Center.ToVector2() - Game1.player.GetBoundingBox().Center.ToVector2();
        Game1.player.faceDirection(Math.Abs(delta.X) > Math.Abs(delta.Y) ? delta.X > 0 ? 1 : 3 : delta.Y > 0 ? 2 : 0);
        Game1.player.lastClick = a.Target.GetBoundingBox().Center.ToVector2();
        a.Submitted = true;
        // Same public entry points as the inspected Game1 input dispatch. The
        // public special method checks the native cooldown and raises its event.
        // BeginUsingTool is not the normal non-scythe melee left-click path.
        if (a.Mode == "attack") a.Weapon.leftClick(Game1.player);
        else a.Weapon.animateSpecialMove(Game1.player);
        ObserveAcceptance(a);
    }
    internal static void ObserveAcceptance(Attempt a)
    {
        a.SawSpecial |= a.Weapon.isOnSpecial;
        // Ordinary idle animation frame changes are not acceptance evidence.
        // The attack entry synchronously locks tool/movement; special uses its
        // native event and may only become visible on a later update tick.
        a.Accepted |= a.Mode == "attack" ? Game1.player.UsingTool && !Game1.player.CanMove
            : a.Weapon.isOnSpecial || Cooldown(a.Weapon) > a.BeforeCooldown;
    }
    internal static bool Settled(Attempt a) => Idle(a.Weapon);
    private sealed record Change(string TargetKey, string Type, int? BeforeHealth, int Health, bool Present,
        Life? LifeBefore, Life LifeAfter, bool NativeDeathVerified, string? DeathProofRule);
    private static Change MonsterChange(Monster m, int? health, Life? before, bool present, long kills, bool confirmed)
    {
        var rule = confirmed && before is not null && health is > 0 ? DeathRule(m, before, kills, present) : null;
        return new(MineActions.Key(m), m.GetType().FullName!, health, m.Health, present, before, Lifecycle(m), rule is not null, rule);
    }
    internal static object Finish(Attempt a)
    {
        var changes = InventoryActions.Changes(a.Inventory);
        var confirmed = ContextMatches(a) && a.Accepted && Settled(a) && Game1.player.health >= a.HealthFloor
            && a.ObservedHealthLoss <= a.MaxHealthLoss && Game1.player.Money >= a.Money && Game1.player.Stamina + 0.001f >= a.Energy
            && changes.All(c => c.Amount >= 0) && Vector2.Distance(Game1.player.Tile, a.Start) <= a.MaxDisplacement;
        var present = a.Location.characters.Contains(a.Target); var killDelta = (long)Game1.player.stats.MonstersKilled - a.Killed;
        var removedWithKillEvidence = !present && a.Target.Health <= 0 && killDelta > 0;
        var lifeAfter = Lifecycle(a.Target);
        var deathRule = DeathRule(a.Target, a.TargetLife, killDelta, present);
        var current = a.Location.characters.OfType<Monster>().Take(129).ToArray();
        var rosterComplete = current.Length <= 128 && current.All(Native);
        // A cleared/wrapped event counter cannot be adopted as another life.
        // All terminal claims require the full action/resource receipt as well.
        confirmed &= rosterComplete && lifeAfter.DeathAnimationCounter is int end
            && a.TargetLife.DeathAnimationCounter is int start && end >= start && killDelta >= 0;
        var monsterChanges = a.Monsters.Select(pair => MonsterChange(pair.Value.Monster, pair.Value.Health, a.Lives[pair.Key],
                a.Location.characters.Contains(pair.Value.Monster), killDelta, confirmed))
            .Concat(current.Where(Native).Where(m => !a.Monsters.ContainsKey(MineActions.Key(m)))
                .Select(m => MonsterChange(m, null, null, true, killDelta, confirmed))).ToArray();
        if (monsterChanges.Count(c => c.NativeDeathVerified) > killDelta)
        {
            confirmed = false;
            monsterChanges = monsterChanges.Select(c => c with { NativeDeathVerified = false, DeathProofRule = null }).ToArray();
        }
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed, mode = a.Mode, nativeActionSubmitted = a.Submitted,
            nativeActionAccepted = a.Accepted, sawNativeSpecial = a.SawSpecial, targetKey = MineActions.Key(a.Target), targetType = a.TargetType,
            targetHealthBefore = a.TargetHealth, targetHealthAfter = a.Target.Health, targetPresent = present,
            targetRemovedWithKillEvidence = removedWithKillEvidence, targetDeathVerified = confirmed && deathRule is not null,
            targetDeathProofRule = confirmed ? deathRule : null, targetLifeBefore = a.TargetLife, targetLifeAfter = lifeAfter,
            targetCollapsedForRevival = confirmed && a.Target.GetType() == typeof(Mummy) && present && a.Target.Health > 0
                && a.TargetLife.MummyReviveTimerMs is <= 0 && lifeAfter.MummyReviveTimerMs is > 0
                && lifeAfter.DeathAnimationCounter - a.TargetLife.DeathAnimationCounter == 1,
            targetDamageCauseVerified = false, monstersKilledDelta = killDelta, rosterComplete, monsterChanges, before = a.Before, after = Query(),
            observedHealthLoss = a.ObservedHealthLoss, inventoryChanges = changes, goldBefore = a.Money, goldAfter = Game1.player.Money,
            note = "One accepted native action and bounded observed effects. Terminal death is reported only by the exact-build event/removal rule or inspected native mummy rule; it does not prove this action caused damage/death, loot attribution, encounter/floor clearance or safe retreat." };
    }
}
