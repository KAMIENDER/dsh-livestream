using StardewModdingAPI;
using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickMineTravel(Job current)
    {
        var a = current.Mine ?? throw new InvalidOperationException("Missing native mine attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("mine_travel_time_limit"); return; }
        if (!Context.IsWorldReady) return; // Normal native fade/loading may temporarily hide the world.
        if (!Context.IsMainPlayer || Context.IsMultiplayer || GameFacts.SaveId() != a.Save || GameFacts.DayKey() != a.Day) { Finish("mine_travel_identity_changed"); return; }
        if (Game1.player.health <= 0) { Finish("mine_travel_health_limit"); return; }
        // Charge every observed decline, not just the final net loss. A healing
        // buff or potion cannot silently restore this attempt's damage budget.
        a.ObservedHealthLoss += Math.Max(0, a.LastHealth - Game1.player.health); a.LastHealth = Game1.player.health;
        if (Game1.player.health < a.HealthFloor || a.ObservedHealthLoss > a.MaxHealthLoss) { Finish("mine_travel_health_limit"); return; }
        if (!a.Submitted)
        {
            if (!MineActions.BeforeInput(a)) { Finish("mine_changed_before_input"); return; }
            a.World ??= WorldInteraction.Begin(a.Exit.X, a.Exit.Y, a.NeutralSlot);
            a.World.Tick(helper, ResolveButton("action")); current.Submitted = a.Submitted; return;
        }
        if (ReferenceEquals(Game1.currentLocation, a.Mine))
        {
            if (a.Operation != "descend") MineActions.Choose(a);
            else if (Game1.activeClickableMenu is not null || Game1.eventUp) { Finish("mine_descent_needs_unexpected_ui"); }
            return;
        }
        if (!MineActions.DestinationMatches(a)) { Finish("mine_destination_changed"); return; }
        if (a.Operation == "shaft" && Game1.activeClickableMenu is not null) { MineActions.CloseFallMessage(a); return; }
        if (Game1.activeClickableMenu is not null || Game1.eventUp || Game1.fadeToBlack || !Context.CanPlayerMove || Game1.player.UsingTool) { a.StableTicks = 0; return; }
        var stable = System.Text.Json.JsonSerializer.Serialize(MineActions.State(), LocalServer.Json);
        a.StableTicks = stable == a.Stable ? a.StableTicks + 1 : 0; a.Stable = stable;
        if (a.StableTicks < 8) return;
        var result = MineActions.Finish(a); job = null; current.Completion.TrySetResult(result);
    }
}
