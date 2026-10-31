using Microsoft.Xna.Framework;
using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickSlingshot(Job current)
    {
        var a = current.Shot ?? throw new InvalidOperationException("Missing pinned native shot");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("slingshot_time_limit"); return; }
        if (!SlingshotActions.ShotContext(a)) { Finish("slingshot_identity_location_or_configuration_changed"); return; }
        a.ObservedHealthLoss += Math.Max(0, a.LastHealth - Game1.player.health); a.LastHealth = Game1.player.health;
        if (Game1.player.health <= 0 || Game1.player.health < a.HealthFloor || a.ObservedHealthLoss > a.MaxHealthLoss) { Finish("slingshot_health_limit"); return; }
        if (Vector2.Distance(Game1.player.Tile, a.Start) > a.MaxDisplacement || Game1.activeClickableMenu is not null || Game1.eventUp || Game1.fadeToBlack
            || !SlingshotActions.ShotPoseReady()) { Finish("slingshot_pose_or_ui_changed"); return; }
        var button = ResolveButton("use_tool");
        if (!a.Begun)
        {
            if (!SlingshotActions.ShotBeforeRelease(a) || Game1.player.UsingTool || Game1.player.usingSlingshot || !Game1.player.CanMove)
            { Finish("slingshot_precondition_changed_before_input"); return; }
            if (helper.Input.IsDown(button)) return; // Do not adopt the user's existing hold.
            // Freeze the initial cursor point while input snapshots catch up;
            // recomputing it every tick would never settle on a moving monster.
            // Final aim is tracked again during the native charging phase.
            if (current.Stage != "initial_pointer") { a.Aim = SlingshotActions.Aim(a, true); current.Stage = "initial_pointer"; }
            var p = SlingshotActions.Pointer(a.Aim);
            Game1.setMousePosition(p.X, p.Y, true);
            if (!PointerSnapshotsReady(p)) return;
            current.Submitted = true; helper.Input.Press(button); SlingshotActions.BeginShot(a); current.Stage = "charging"; return;
        }
        if (!a.ReleaseSubmitted)
        {
            if (!SlingshotActions.ShotBeforeRelease(a) || !Game1.player.UsingTool || !Game1.player.usingSlingshot)
            { Finish("slingshot_charge_interrupted_or_precondition_changed"); return; }
            // Press is a one-tick SMAPI hold. Continue until the actual public
            // release entry finishes the sling; never drop a charged hold first.
            helper.Input.Press(button);
            if (current.Stage != "aim_settle")
            {
                ++a.DrawTicks;
                // Legacy tickUpdate requires mouse motion >8px after its fifth
                // drag tick. An instantaneous pull before that gate never arms
                // the shot. Ramp the draw while charging, then settle final aim.
                a.Aim = SlingshotActions.Aim(a, false, Math.Min(1f, a.DrawTicks / 8f));
                if (a.DrawTicks >= 8 && SlingshotActions.Charged(a)) current.Stage = "aim_settle";
            }
            var p = SlingshotActions.Pointer(a.Aim); Game1.setMousePosition(p.X, p.Y, true);
            if (current.Stage != "aim_settle" || !PointerSnapshotsReady(p) || !SlingshotActions.AimMatches(a, a.Aim)) return;
            SlingshotActions.ReleaseShot(a); current.Stage = "projectile_flight"; return;
        }
        if (Game1.player.UsingTool || Game1.player.usingSlingshot) { Finish("slingshot_new_input_after_release"); return; }
        if (!SlingshotActions.ShotSettled(a)) { a.StableTicks = 0; return; }
        if (++a.StableTicks < 8) return;
        var result = SlingshotActions.FinishShot(a); job = null; current.Completion.TrySetResult(result);
    }

}
