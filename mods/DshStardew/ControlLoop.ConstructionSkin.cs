using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickConstructionSkin(Job current)
    {
        var a = current.ConstructionSkin ?? throw new InvalidOperationException("Missing native skin attempt");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("construction_skin_time_limit"); return; }
        if (!ConstructionActions.SkinContext(a) || Game1.player.health <= 0) { Finish("construction_skin_context_changed"); return; }
        if (!a.Submitted) {
            if (!ConstructionActions.BeforeSkinInput(a)) { Finish("construction_skin_changed_before_input"); return; }
            Game1.setMousePosition(a.Pointer.X, a.Pointer.Y, true);
            if (!PointerSnapshotsReady(a.Pointer) || !ConstructionActions.SkinPointerReady(a)) return;
            current.Submitted = true; ConstructionActions.ExecuteSkin(a); return;
        }
        if (!ConstructionActions.SkinSettled(a)) { a.StableTicks = 0; return; }
        if (++a.StableTicks < 8) return;
        var result = ConstructionActions.FinishSkin(a); job = null; current.Completion.TrySetResult(result);
    }
}
