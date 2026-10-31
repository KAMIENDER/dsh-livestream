namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickStorage(Job current)
    {
        var attempt = current.Storage ?? throw new InvalidOperationException("Missing native storage UI action");
        if (!attempt.Submitted)
        {
            if (!StorageActions.ContextMatches(attempt)) { Finish("storage_changed_before_submission"); return; }
            current.Submitted = true; StorageActions.Execute(attempt); return;
        }
        if (attempt.World is { Pressed: false } world)
        {
            if (!StorageActions.ContextMatches(attempt)) { Finish("storage_changed_before_native_input"); return; }
            world.Tick(helper, ResolveButton("action")); return;
        }
        if (StorageActions.Waiting(attempt)) return;
        var result = StorageActions.Finish(attempt);
        job = null; current.Completion.TrySetResult(result);
    }
}
