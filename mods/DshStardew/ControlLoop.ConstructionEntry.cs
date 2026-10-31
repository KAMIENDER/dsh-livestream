using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickConstructionEntry(Job current)
    {
        var a = current.ConstructionEntry ?? throw new InvalidOperationException("Missing native construction entry");
        if (++current.Ticks > current.MaxTicks || DateTimeOffset.UtcNow >= current.Deadline) { Finish("construction_entry_time_limit"); return; }
        if (!ConstructionActions.EntryContext(a) || Game1.player.health <= 0) { Finish("construction_entry_context_changed"); return; }
        if (a.Operation == "open" && a.World?.Pressed != true)
        {
            if (!ConstructionActions.BeforeEntryInput(a)) { Finish("construction_entry_precondition_changed"); return; }
            if (a.World is null)
            {
                current.Submitted = true; a.Started = true;
                a.World = WorldInteraction.Begin(a.X, a.Y, a.Slot);
            }
            a.World.Tick(helper, ResolveButton("action")); return;
        }
        if (a.Operation != "open" && !a.Submitted)
        {
            if (!ConstructionActions.BeforeEntryInput(a)) { Finish("construction_question_changed_before_input"); return; }
            var p = ConstructionActions.EntryPointer(a); if (p is null) return;
            Game1.setMousePosition(p.Value.X, p.Value.Y, true);
            if (!PointerSnapshotsReady(p.Value)) return;
            current.Submitted = true; ConstructionActions.ExecuteEntry(a, p.Value); return;
        }
        if (!ConstructionActions.EntrySettled(a)) { a.StableTicks = 0; return; }
        if (++a.StableTicks < 8) return;
        var result = ConstructionActions.FinishEntry(a); job = null; current.Completion.TrySetResult(result);
    }
}
