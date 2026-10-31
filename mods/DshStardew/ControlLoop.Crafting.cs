namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickCrafting(Job current)
    {
        var attempt = current.Craft ?? throw new InvalidOperationException("Missing native crafting action");
        if (!attempt.Submitted)
        {
            if (!CraftingActions.ContextMatches(attempt)) { Finish("crafting_context_changed_before_submission"); return; }
            // Recipe/inventory clicks use explicit x/y, so do not move the real
            // cursor onto a recipe preview. World station access separately uses
            // a synchronized cursor and one configured native action edge.
            current.Submitted = true; CraftingActions.Execute(attempt);
            return; // Observe on a later tick, including asynchronous native station locks.
        }
        if (attempt.World is { Pressed: false } world)
        {
            if (!CraftingActions.ContextMatches(attempt)) { Finish("crafting_changed_before_native_input"); return; }
            world.Tick(helper, ResolveButton("action")); return;
        }
        if (CraftingActions.WaitingForOpen(attempt)) return;
        var result = CraftingActions.Finish(attempt);
        job = null; current.Completion.TrySetResult(result);
    }
}
