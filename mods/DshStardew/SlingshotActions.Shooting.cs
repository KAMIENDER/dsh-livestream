using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.Projectiles;
using StardewValley.Tools;

namespace DshStardew;

internal static partial class SlingshotActions
{
    // NetCharacterRef.Get(location) is the inspected public resolver. Do not use
    // BasicProjectile.GetPlayerWhoFiredMe: it falls back to Game1.player when
    // ownership cannot be resolved and would falsely label an unknown projectile.
    private static object ProjectileFact(Projectile p) => new { projectileKey = MineActions.Key(p), type = p.GetType().FullName,
        native = p.GetType().Assembly == typeof(Game1).Assembly, itemId = p.itemId.Value,
        firedByPlayer = ReferenceEquals(p.theOneWhoFiredMe.Get(Game1.currentLocation), Game1.player),
        position = R.Plain(p.position.Value), xVelocity = p.xVelocity.Value, yVelocity = p.yVelocity.Value,
        p.destroyMe, damagesMonsters = p.damagesMonsters.Value, nativeExplodeFlag = p is BasicProjectile b ? (bool?)b.explode.Value : null };
    private static Projectile[] Projectiles() => Game1.currentLocation.projectiles.Take(257).ToArray();
    private static bool MouseAimAvailable() => R.Get(Game1.options, "gamepadControls") is false
        || R.Get(Game1.options, "gamepadControls") is true && R.Get(typeof(Game1), "lastCursorMotionWasMouse") is true;
    private static object ShootingQuery()
    {
        var projectiles = Projectiles();
        return new { complete = projectiles.Length <= 256, poseReady = ShotPoseReady(), mouseAimAvailable = MouseAimAvailable(),
            nonCombatantsPresent = NonCombatantsPresent(),
            projectiles = projectiles.Take(256).Select(ProjectileFact).ToArray() };
    }
    // BasicProjectile.behaviorOnCollisionWithMonster accepts NPC, and its
    // non-Monster path calls NPC.getHitByPlayer. A monster-only approval must
    // not silently authorize friendship damage. No new friendly-fire grant.
    private static bool NonCombatantsPresent() => Game1.currentLocation.characters.Any(n => n is not Monster);
    private static bool MummyCollapsed(Monster m) => m.GetType() == typeof(Mummy) && MeleeActions.Lifecycle(m).MummyReviveTimerMs is > 0;
    internal static bool ShotPoseReady() => MeleeActions.PoseReady() && !Game1.player.IsSitting() && !Game1.player.isRidingHorse()
        && R.Get(Game1.player, "isEating") is false && !NonCombatantsPresent();
    private static bool IdleShot() => ShotPoseReady() && Context.CanPlayerMove && Game1.player.CanMove
        && !Game1.player.UsingTool && !Game1.player.usingSlingshot && !Game1.player.FarmerSprite.PauseForSingleAnimation
        && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.fadeToBlack;
    private static string WeaponConfiguration(Slingshot s) => Hash(new { key = MineActions.Key(s), s.QualifiedItemId,
        enchantments = R.Items(R.Get(s, "enchantments")).Select(e => new { type = e.GetType().FullName, level = R.Plain(R.Get(e, "level")) }).ToArray(),
        slots = s.attachments.Length });
    private static double Bounded(JsonElement args, string name, double fallback, double min, double max)
    {
        var value = fallback;
        if (args.TryGetProperty(name, out var node)) InventoryActions.Require(node.ValueKind == JsonValueKind.Number && node.TryGetDouble(out value), $"{name} must be a number");
        InventoryActions.Require(double.IsFinite(value) && value >= min && value <= max, $"{name} is outside its range"); return value;
    }
    internal sealed class Shot
    {
        public Farmer Player = null!;
        public GameLocation Location = null!;
        public Slingshot Sling = null!;
        public Monster Target = null!;
        public string Save = "", Day = "", Configuration = "", InventoryDigest = "", AttachmentDigest = "", TargetType = "";
        public int Slot, Health, LastHealth, HealthFloor, MaxHealthLoss, ObservedHealthLoss, Money, TargetHealth;
        public float Energy;
        public uint Kills;
        public Vector2 Start;
        public double MaxRange, MaxDisplacement;
        public bool Legacy, Begun, ReleaseSubmitted, ReleaseReturned, Accepted, Ended;
        public int StableTicks, DrawTicks;
        public Ammo BeforeAmmo = null!;
        public object Before = null!, InitialProjectile = null!;
        public InventoryActions.Count[] Inventory = Array.Empty<InventoryActions.Count>();
        public Dictionary<string, (Monster Monster, int Health, MeleeActions.Life Life)> Monsters = new();
        public MeleeActions.Life TargetLife = new(null, null);
        public BasicProjectile? Projectile;
        public Attached[] OtherAttachments = Array.Empty<Attached>();
        public Point Aim;
        public float ReleaseCharge;
        public int ReleaseBackArm;
    }
    internal static Shot PrepareShot(JsonElement args)
    {
        InventoryActions.Require(Supported() && CaptureSupported() && IdleShot() && MouseAimAvailable(), "Shot requires an idle native single-player world and actual mouse aim");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] {
            "locationKey", "targetKey", "expectedTargetType", "expectedDeathAnimationCounter", "expectedMummyCollapsed", "slingshotSlot", "expectedSlingshotItemId", "toolKey", "gearDigest",
            "inventoryDigest", "attachmentSetDigest", "expectedAmmoItemId", "expectedAmmoQuality", "expectedAmmoStack", "ammoItemKey", "expectedLegacyFiring",
            "expectedHealth", "expectedMoney", "healthFloor", "maxHealthLoss", "maxRangeTiles", "maxDisplacementTiles", "allowExplosive", "durationMs",
        }.Contains(p.Name)), "Unknown shot argument");
        var slot = R.Int(args, "slingshotSlot", -1, 0, Game1.player.Items.Count - 1);
        InventoryActions.Require(Game1.player.CurrentToolIndex == slot && Game1.player.Items[slot]?.GetType() == typeof(Slingshot)
            && ReferenceEquals(Game1.player.CurrentTool, Game1.player.Items[slot]), "Equip the exact owned native slingshot first");
        var sling = (Slingshot)Game1.player.Items[slot]; var d = Descriptor(sling, slot); var ammo = Ammunition(sling);
        InventoryActions.Require(sling.attachments.Length == 1 && !sling.CanAutoFire() && R.Bool(d, "nativeEnchantmentsOnly")
            && MineActions.Key(sling) == R.Arg(args, "toolKey") && sling.QualifiedItemId == R.Arg(args, "expectedSlingshotItemId")
            && R.Text(d, "gearDigest") == R.Arg(args, "gearDigest") && ReferenceEquals(R.Raw(sling, "lastUser"), Game1.player)
            && sling.attachments[0] is { } attached && Ordinary(attached)
            && ammo.ItemId == R.Arg(args, "expectedAmmoItemId") && ammo.Quality == R.Int(args, "expectedAmmoQuality", -1, 0, 4)
            && ammo.Stack == R.Int(args, "expectedAmmoStack", 0, 1, 10000) && ammo.ItemKey == R.Arg(args, "ammoItemKey"), "Native slingshot/configuration or exact ammunition changed");
        InventoryActions.Require(args.TryGetProperty("allowExplosive", out var explosive) && explosive.ValueKind is JsonValueKind.True or JsonValueKind.False
            && (!ammo.Explosive || explosive.ValueKind == JsonValueKind.True), "Explosive discharge requires explicit permission");
        InventoryActions.Require(args.TryGetProperty("expectedLegacyFiring", out var legacy) && legacy.ValueKind is JsonValueKind.True or JsonValueKind.False
            && R.Get(Game1.options, "useLegacySlingshotFiring") is bool actualLegacy && actualLegacy == legacy.GetBoolean(), "Actual native firing option changed");
        var monsters = Game1.currentLocation.characters.OfType<Monster>().Take(129).ToArray(); var projectiles = Projectiles();
        InventoryActions.Require(monsters.Length <= 128 && monsters.All(m => m.GetType().Assembly == typeof(Game1).Assembly)
            && projectiles.Length <= 256 && projectiles.All(p => p.GetType().Assembly == typeof(Game1).Assembly), "Combat/projectile roster is incomplete or contains custom types");
        var target = monsters.SingleOrDefault(m => MineActions.Key(m) == R.Arg(args, "targetKey"));
        InventoryActions.Require(target is not null && target.Health > 0 && target.GetType().FullName == R.Arg(args, "expectedTargetType")
            && MeleeActions.Lifecycle(target).DeathAnimationCounter == R.Int(args, "expectedDeathAnimationCounter", -1, 0, int.MaxValue)
            && MineActions.Key(Game1.currentLocation) == R.Arg(args, "locationKey"), "Pinned native target/lifecycle or location changed");
        InventoryActions.Require(args.TryGetProperty("expectedMummyCollapsed", out var phase) && phase.ValueKind is JsonValueKind.True or JsonValueKind.False
            && phase.GetBoolean() == MummyCollapsed(target!) && (!phase.GetBoolean() || ammo.Explosive)
            && (target!.GetType() != typeof(Mummy) || MeleeActions.Lifecycle(target).MummyReviveTimerMs is not null),
            "Pinned mummy active/collapsed phase changed or collapsed target lacks explicitly authorized explosive ammunition");
        var a = new Shot { Player = Game1.player, Location = Game1.currentLocation, Sling = sling, Target = target!, TargetType = target!.GetType().FullName!,
            Save = GameFacts.SaveId(), Day = GameFacts.DayKey(), Slot = slot, Configuration = WeaponConfiguration(sling), BeforeAmmo = ammo,
            InventoryDigest = InventoryActions.Digest(), AttachmentDigest = Hash(Attachments()), OtherAttachments = Attachments().Where(a => a.ToolSlot != slot).ToArray(),
            Inventory = InventoryActions.Counts(), Health = Game1.player.health, LastHealth = Game1.player.health, Money = Game1.player.Money, Energy = Game1.player.Stamina,
            HealthFloor = R.Int(args, "healthFloor", 30, 1, 1000), MaxHealthLoss = R.Int(args, "maxHealthLoss", 0, 0, 1000), Start = Game1.player.Tile,
            MaxRange = Bounded(args, "maxRangeTiles", 12, 1, 20), MaxDisplacement = Bounded(args, "maxDisplacementTiles", 2, 0, 8),
            Legacy = legacy.GetBoolean(), Kills = Game1.player.stats.MonstersKilled, TargetHealth = target.Health, TargetLife = MeleeActions.Lifecycle(target),
            Monsters = monsters.ToDictionary(MineActions.Key, m => (m, m.Health, MeleeActions.Lifecycle(m))), Before = new { slingshot = Query(default), combat = MeleeActions.Query() } };
        InventoryActions.Require(a.InventoryDigest == R.Arg(args, "inventoryDigest") && a.AttachmentDigest == R.Arg(args, "attachmentSetDigest")
            && a.Health == R.Int(args, "expectedHealth", -1, 1, 1000) && a.Money == R.Int(args, "expectedMoney", -1, 0, int.MaxValue)
            && a.Health >= a.HealthFloor && Game1.timeOfDay < 2200 && Vector2.Distance(a.Target.Tile, a.Start) <= a.MaxRange, "Inventory, attachment, resource, time or target range precondition changed");
        // Check both initial and drawn positions before any input; legacy draws
        // opposite the target around standingPosition, with the native 40px
        // height correction. Keep the user's setting; do not force gamepad mode.
        Pointer(Aim(a, true)); Pointer(Aim(a, false)); return a;
    }
    internal static bool ShotContext(Shot a) => Supported() && Context.IsWorldReady && Context.IsMainPlayer && !Context.IsMultiplayer
        && ReferenceEquals(Game1.player, a.Player) && ReferenceEquals(Game1.currentLocation, a.Location)
        && GameFacts.SaveId() == a.Save && GameFacts.DayKey() == a.Day && Game1.player.CurrentToolIndex == a.Slot
        && ReferenceEquals(Game1.player.CurrentTool, a.Sling) && WeaponConfiguration(a.Sling) == a.Configuration
        && R.Get(Game1.options, "useLegacySlingshotFiring") is bool legacy && legacy == a.Legacy;
    internal static bool ShotBeforeRelease(Shot a) => ShotContext(a) && ShotPoseReady() && MouseAimAvailable() && CaptureSupported()
        && a.Location.characters.Contains(a.Target) && a.Target.Health > 0 && MeleeActions.Lifecycle(a.Target).DeathAnimationCounter == a.TargetLife.DeathAnimationCounter
        // Revival counts down without necessarily changing the death-event
        // counter. Bind the active/collapsed phase as well, not its ticking value.
        && MummyCollapsed(a.Target) == (a.TargetLife.MummyReviveTimerMs is > 0)
        && Vector2.Distance(a.Target.Tile, a.Start) <= a.MaxRange && Game1.timeOfDay < 2200
        && InventoryActions.Digest() == a.InventoryDigest && Hash(Attachments()) == a.AttachmentDigest && Ammunition(a.Sling) == a.BeforeAmmo
        && Game1.player.Money >= a.Money && Game1.player.Stamina + 0.001f >= a.Energy
        && a.Location.characters.OfType<Monster>().Take(129).Count() <= 128 && a.Location.characters.OfType<Monster>().All(m => m.GetType().Assembly == typeof(Game1).Assembly)
        && Projectiles().Length <= 256 && Projectiles().All(p => p.GetType().Assembly == typeof(Game1).Assembly);
    internal static Point Aim(Shot a, bool initial, float drawFraction = 1f)
    {
        var standing = a.Player.getStandingPosition(); var target = a.Target.GetBoundingBox().Center.ToVector2();
        var origin = a.Sling.GetShootOrigin(a.Player); var delta = target - origin;
        InventoryActions.Require(delta.LengthSquared() >= 1 && float.IsFinite(delta.X) && float.IsFinite(delta.Y), "Target has no finite shot direction");
        var aim = a.Legacy ? initial ? standing : standing - Vector2.Normalize(delta) * (160f * drawFraction) : target;
        return new Point((int)aim.X, (int)aim.Y);
    }
    internal static Point Pointer(Point world)
    {
        var scale = Game1.options.uiScale / Game1.options.zoomLevel;
        InventoryActions.Require(float.IsFinite(scale) && scale > 0, "Native world/UI scale is unavailable");
        var p = new Point((int)((world.X - Game1.viewport.X) / scale), (int)((world.Y - Game1.viewport.Y) / scale));
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Native shot aim is off screen"); return p;
    }
    internal static bool AimMatches(Shot a, Point expected)
    {
        var aim = R.Get(a.Sling, "aimPos");
        return aim is Point p && Math.Abs(p.X - expected.X) <= 3 && Math.Abs(p.Y - expected.Y) <= 3;
    }
    internal static bool Charged(Shot a) => Game1.player.usingSlingshot && Game1.player.UsingTool
        && a.Sling.GetSlingshotChargeTime() >= 1f && a.Sling.GetBackArmDistance(Game1.player) > 4 && R.Get(a.Sling, "canPlaySound") is false;
    internal static void BeginShot(Shot a)
    {
        a.Begun = true; a.Player.BeginUsingTool();
        InventoryActions.Require(a.Player.UsingTool && a.Player.usingSlingshot && !a.Player.CanMove, "Native slingshot begin was not accepted");
    }
    internal static void ReleaseShot(Shot a)
    {
        InventoryActions.Require(!a.ReleaseSubmitted && Charged(a) && ShotBeforeRelease(a) && AimMatches(a, a.Aim), "Shot charge/aim/preconditions changed before native release");
        var previous = Projectiles(); InventoryActions.Require(previous.Length <= 256, "Projectile roster exceeds its bound");
        a.ReleaseCharge = a.Sling.GetSlingshotChargeTime(); a.ReleaseBackArm = a.Sling.GetBackArmDistance(a.Player);
        a.ReleaseSubmitted = true;
        // Same public release entry as native input. EndUsingTool specifically
        // excludes slingshots. onRelease dispatches DoFunction/PerformFire and
        // finish; never call private aim/fire, damageMonster or spawn a projectile.
        a.ReleaseReturned = a.Sling.onRelease(a.Location, a.Aim.X, a.Aim.Y, a.Player);
        // Observe synchronously before the subsequent world update can collide
        // and remove a fast projectile. No event subscriptions or collision hooks.
        var all = Projectiles(); var added = all.Where(p => !previous.Contains(p)).ToArray();
        InventoryActions.Require(all.Length <= 256 && added.Length == 1 && added[0].GetType() == typeof(BasicProjectile), "Native release did not expose exactly one new basic projectile");
        a.Projectile = (BasicProjectile)added[0]; a.InitialProjectile = ProjectileFact(a.Projectile);
        a.Accepted = a.ReleaseReturned && ReferenceEquals(a.Projectile.theOneWhoFiredMe.Get(a.Location), a.Player)
            // PerformFire passes false for the native explode field even for
            // explosive ammo: that ammo uses its collision callback instead.
            && a.Projectile.itemId.Value == a.BeforeAmmo.ItemId && a.Projectile.damagesMonsters.Value && !a.Projectile.explode.Value
            && AmmoSpent(a) && !a.Player.usingSlingshot && !a.Player.UsingTool;
        InventoryActions.Require(a.Accepted, "Projectile ownership/type/ammo or native release completion is uncertain");
    }
    private static bool AmmoSpent(Shot a)
    {
        var after = Ammunition(a.Sling);
        return a.BeforeAmmo.Stack == 1 ? after.ItemId is null && after.Stack == 0
            : after.ItemId == a.BeforeAmmo.ItemId && after.Quality == a.BeforeAmmo.Quality && after.ItemKey == a.BeforeAmmo.ItemKey && after.Stack == a.BeforeAmmo.Stack - 1;
    }
    internal static bool ShotSettled(Shot a)
    {
        // Disappearance/destroyMe ends observation of this actual reference;
        // neither condition identifies a collision, hit, explosion or cause.
        a.Ended |= a.Projectile is not null && (!a.Location.projectiles.Contains(a.Projectile) || a.Projectile.destroyMe);
        return a.Accepted && a.Ended && IdleShot();
    }
    internal static bool CancelCharging(Shot a)
    {
        if (!a.Begun || a.ReleaseReturned) return true;
        if (!Context.IsWorldReady || !ReferenceEquals(Game1.player, a.Player) || !ReferenceEquals(Game1.currentLocation, a.Location)
            || !ReferenceEquals(Game1.player.CurrentTool, a.Sling) || !ReferenceEquals(R.Raw(a.Sling, "lastUser"), a.Player)) return false;
        // Stop through the native non-firing finish event before dropping the
        // synthetic hold; otherwise a stopped controller could release a shot.
        if (a.Player.usingSlingshot || a.Player.UsingTool) a.Sling.finish();
        return !a.Player.usingSlingshot && !a.Player.UsingTool;
    }
    internal static object FinishShot(Shot a)
    {
        var changes = InventoryActions.Changes(a.Inventory); var present = a.Location.characters.Contains(a.Target);
        var kills = (long)Game1.player.stats.MonstersKilled - a.Kills; var life = MeleeActions.Lifecycle(a.Target);
        var current = a.Location.characters.OfType<Monster>().Take(129).ToArray(); var projectiles = Projectiles();
        var rosterComplete = current.Length <= 128 && current.All(m => m.GetType().Assembly == typeof(Game1).Assembly)
            && projectiles.Length <= 256 && projectiles.All(p => p.GetType().Assembly == typeof(Game1).Assembly);
        var confirmed = ShotContext(a) && ShotSettled(a) && rosterComplete && CaptureSupported() && AmmoSpent(a)
            && a.Projectile is not null && ReferenceEquals(a.Projectile.theOneWhoFiredMe.Get(a.Location), a.Player)
            && a.Projectile.itemId.Value == a.BeforeAmmo.ItemId && a.Projectile.damagesMonsters.Value
            && a.OtherAttachments.SequenceEqual(Attachments().Where(t => t.ToolSlot != a.Slot)) && changes.All(c => c.Amount >= 0)
            && Game1.player.health >= a.HealthFloor && a.ObservedHealthLoss <= a.MaxHealthLoss && Game1.player.Money >= a.Money
            && Game1.player.Stamina + 0.001f >= a.Energy && Vector2.Distance(Game1.player.Tile, a.Start) <= a.MaxDisplacement;
        var actors = a.Monsters.Values.Select(v => v.Monster).Concat(current).Distinct().Select(m => {
            var has = a.Monsters.TryGetValue(MineActions.Key(m), out var old); var inWorld = a.Location.characters.Contains(m);
            var rule = has && old.Health > 0 ? MeleeActions.DeathRule(m, old.Life, kills, inWorld) : null;
            return new { targetKey = MineActions.Key(m), type = m.GetType().FullName, beforeHealth = has ? (int?)old.Health : null, health = m.Health,
                present = inWorld, lifeBefore = has ? old.Life : null, lifeAfter = MeleeActions.Lifecycle(m), nativeDeathVerified = rule is not null, deathProofRule = rule };
        }).ToArray();
        if (actors.Count(m => m.nativeDeathVerified) > kills) confirmed = false;
        var rule = confirmed ? MeleeActions.DeathRule(a.Target, a.TargetLife, kills, present) : null;
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed, nativeActionSubmitted = a.Begun, nativeReleaseSubmitted = a.ReleaseSubmitted,
            nativeReleaseReturned = a.ReleaseReturned, projectileObserved = a.Accepted, projectileEnded = a.Ended,
            projectileKey = a.Projectile is null ? null : MineActions.Key(a.Projectile), initialProjectile = a.InitialProjectile,
            finalProjectile = a.Projectile is null ? null : ProjectileFact(a.Projectile), projectilePresent = a.Projectile is not null && a.Location.projectiles.Contains(a.Projectile),
            legacyFiring = a.Legacy, chargeAtRelease = a.ReleaseCharge, backArmAtRelease = a.ReleaseBackArm, aimAtRelease = R.Plain(a.Aim),
            slingshotSlot = a.Slot, toolKey = MineActions.Key(a.Sling), beforeAmmo = a.BeforeAmmo, afterAmmo = Ammunition(a.Sling), ammunitionSpent = AmmoSpent(a) ? 1 : (int?)null,
            targetKey = MineActions.Key(a.Target), targetType = a.TargetType, targetHealthBefore = a.TargetHealth, targetHealthAfter = a.Target.Health, targetPresent = present,
            targetLifeBefore = a.TargetLife, targetLifeAfter = life, targetDeathVerified = rule is not null, targetDeathProofRule = rule,
            targetCollapsedForRevival = confirmed && a.Target.GetType() == typeof(Mummy) && present && a.Target.Health > 0 && a.TargetLife.MummyReviveTimerMs is <= 0
                && life.MummyReviveTimerMs is > 0 && life.DeathAnimationCounter - a.TargetLife.DeathAnimationCounter == 1,
            targetDamageCauseVerified = false, hitVerified = false, explosionVerified = false, monstersKilledDelta = kills, rosterComplete,
            monsterChanges = confirmed ? actors : actors.Select(m => m with { nativeDeathVerified = false, deathProofRule = (string?)null }).ToArray(),
            observedHealthLoss = a.ObservedHealthLoss, inventoryChanges = changes,
            before = a.Before, after = new { slingshot = Query(default), combat = MeleeActions.Query() },
            note = "One native fully charged shot and its actual projectile lifecycle, with observed actor/resource changes. No collision/hit/explosion, damage/loot causality, encounter clearance or safe escape is proven. Unknown/cancelled shots are never replayed." };
    }
}
