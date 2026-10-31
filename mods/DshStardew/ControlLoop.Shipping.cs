using StardewValley;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickShipping(Job current)
    {
        var a = current.Shipping ?? throw new InvalidOperationException("Missing native shipping action");
        if (!a.Submitted || (a.Operation is "deposit" or "withdraw") && a.Done < a.Quantity) {
            if (!ShippingActions.ContextMatches(a)) { Finish("shipping_changed_before_next_submission"); return; }
            current.Submitted = true; ShippingActions.Execute(a); return;
        }
        if (a.World is { Pressed: false } world) {
            if (!ShippingActions.ContextMatches(a)) { Finish("shipping_changed_before_native_input"); return; }
            world.Tick(helper, ResolveButton("action")); return;
        }
        if (a.Operation == "open" && Game1.activeClickableMenu is null) return;
        var result = ShippingActions.Finish(a); job = null; current.Completion.TrySetResult(result);
    }
}
