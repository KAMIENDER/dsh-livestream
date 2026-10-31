using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickConstructionPaint(Job current)
    {
        var a = current.ConstructionPaint ?? throw new InvalidOperationException("Missing native building paint attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("construction_paint_time_limit"); return; }
        if (!ConstructionActions.PaintContext(a) || Game1.player.health <= 0) { Finish("construction_paint_context_changed"); return; }
        if (!a.Submitted) {
            if (!ConstructionActions.BeforePaintInput(a)) { Finish("construction_paint_changed_before_input"); return; }
            Game1.setMousePosition(a.Pointer.X, a.Pointer.Y, true); if (!PointerSnapshotsReady(a.Pointer) || !ConstructionActions.PaintPointerReady(a)) return;
            current.Submitted = true; ConstructionActions.ExecutePaint(a); return;
        }
        if (a.Operation == "slider" && !a.Released) {
            if (!ReferenceEquals(a.Menu?.activeSlider, a.Slider)) { Finish("construction_paint_drag_ownership_changed"); return; }
            Game1.setMousePosition(a.DragPointer.X, a.DragPointer.Y, true);
            // Let the real menu update drive the real slider callback. It uses
            // native mouse coordinates and can reach both endpoint values.
            if (R.Number(a.Slider, "_displayedValue") != a.Value || !PointerSnapshotsReady(a.DragPointer)) return;
            ConstructionActions.ReleasePaint(a);
        }
        if (!ConstructionActions.PaintSettled(a)) { a.StableTicks = 0; return; }
        if (++a.StableTicks < 8) return;
        var result = ConstructionActions.FinishPaint(a); job = null; current.Completion.TrySetResult(result);
    }
}
