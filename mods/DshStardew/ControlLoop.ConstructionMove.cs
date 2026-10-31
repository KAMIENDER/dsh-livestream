using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickConstructionMove(Job current)
    {
        var a = current.ConstructionMove ?? throw new InvalidOperationException("Missing native building move attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("construction_move_time_limit"); return; }
        if (!ConstructionActions.MoveContext(a) || Game1.player.health <= 0) { Finish("construction_move_context_changed"); return; }
        if (a.Operation == "pan" && !a.PanEnded) {
            if (!ConstructionActions.BeforeMoveInput(a)) { Finish("construction_move_pan_changed"); return; }
            current.Submitted = true; ConstructionActions.PanMove(a); return;
        }
        if (!a.Submitted) {
            if (!ConstructionActions.BeforeMoveInput(a)) { Finish("construction_move_changed_before_input"); return; }
            var p = ConstructionActions.MovePointer(a); Game1.setMousePosition(p.X, p.Y, true);
            if (!ConstructionActions.MovePointerReady(a, p)) return;
            current.Submitted = true; ConstructionActions.ExecuteMove(a, p); return;
        }
        if (!ConstructionActions.MoveSettled(a)) { a.StableTicks = 0; return; }
        ConstructionActions.StopMovePan(a); if (++a.StableTicks < 8) return;
        var result = ConstructionActions.FinishMove(a); job = null; current.Completion.TrySetResult(result);
    }
}
