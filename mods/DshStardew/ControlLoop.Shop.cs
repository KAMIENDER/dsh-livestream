namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickShop(Job current)
    {
        var attempt = current.Shop ?? throw new InvalidOperationException("Missing native shop action");
        if (!attempt.Submitted || attempt.Operation == "sell" && attempt.Sold < attempt.Quantity)
        {
            if (!ShopActions.ContextMatches(attempt)) { Finish("shop_changed_before_next_submission"); return; }
            current.Submitted = true; ShopActions.Execute(attempt); return;
        }
        if (attempt.World is { Pressed: false } world)
        {
            if (!ShopActions.ContextMatches(attempt)) { Finish("shop_changed_before_native_input"); return; }
            world.Tick(helper, ResolveButton("action")); return;
        }
        if (ShopActions.Waiting(attempt)) return;
        var result = ShopActions.Finish(attempt);
        job = null; current.Completion.TrySetResult(result);
    }
}
