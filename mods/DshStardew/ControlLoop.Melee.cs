using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickMelee(Job current)
    {
        var a = current.Melee ?? throw new InvalidOperationException("Missing pinned melee attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("melee_action_time_limit"); return; }
        if (!MeleeActions.ContextMatches(a)) { Finish("melee_identity_location_or_weapon_changed"); return; }
        if (Game1.player.health <= 0) { Finish("melee_health_limit"); return; }
        a.ObservedHealthLoss += Math.Max(0, a.LastHealth - Game1.player.health); a.LastHealth = Game1.player.health;
        if (Game1.player.health < a.HealthFloor || a.ObservedHealthLoss > a.MaxHealthLoss) { Finish("melee_health_limit"); return; }
        if (Vector2.Distance(Game1.player.Tile, a.Start) > a.MaxDisplacement || Game1.activeClickableMenu is not null || Game1.eventUp || Game1.fadeToBlack)
        { Finish("melee_pose_or_ui_changed"); return; }
        if (!a.Submitted)
        {
            if (!MeleeActions.BeforeInput(a)) { Finish("melee_precondition_changed_before_input"); return; }
            current.Submitted = true; MeleeActions.Begin(a); return;
        }
        MeleeActions.ObserveAcceptance(a);
        if (!a.Accepted || !MeleeActions.Settled(a)) { a.StableTicks = 0; return; }
        if (++a.StableTicks < 8) return;
        var result = MeleeActions.Finish(a); job = null; current.Completion.TrySetResult(result);
    }
}
