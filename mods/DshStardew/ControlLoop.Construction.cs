using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickConstruction(Job current)
    {
        var a = current.Construction ?? throw new InvalidOperationException("Missing native construction attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("construction_time_limit"); return; }
        if (!ConstructionActions.ContextMatches(a) || Game1.player.health <= 0) { Finish("construction_context_changed"); return; }
        if (a.Operation == "pan" && !a.PanEnded)
        {
            if (!ConstructionActions.BeforeInput(a)) { Finish("construction_pan_precondition_changed"); return; }
            current.Submitted = true; ConstructionActions.Pan(a); return;
        }
        if (!a.Submitted)
        {
            if (!ConstructionActions.BeforeInput(a)) { Finish("construction_precondition_changed_before_input"); return; }
            var p = ConstructionActions.Pointer(a); Game1.setMousePosition(p.X, p.Y, true);
            if (!ConstructionActions.PointerReady(a, p)) return;
            current.Submitted = true; ConstructionActions.Execute(a, p); return;
        }
        if (!ConstructionActions.Settled(a)) { a.StableTicks = 0; return; }
        ConstructionActions.StopPan(a);
        if (++a.StableTicks < 8) return;
        ConstructionActions.StopPan(a);
        var result = ConstructionActions.Finish(a); job = null; current.Completion.TrySetResult(result);
    }
}
