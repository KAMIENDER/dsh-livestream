using StardewModdingAPI;
using StardewValley;
using SObject = StardewValley.Object;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private void TickFood(Job current)
    {
        var food = current.Food ?? throw new InvalidOperationException("Missing owned-food attempt");
        if (Game1.player.itemToEat is not SObject eating || eating.QualifiedItemId != food.ItemId || eating.Quality != food.Quality)
        { Finish("controller_error:EatingItemChanged"); return; }
        if (Game1.eventUp || Game1.activeClickableMenu is not null && food.ItemId != "(O)434")
        { Finish("controller_error:EatingContextChanged"); return; }
        if (Game1.player.isEating) return;
        var specialUi = food.ItemId == "(O)434" && Game1.activeClickableMenu is not null;
        if (!specialUi && (!Context.CanPlayerMove || Game1.player.UsingTool || Game1.fadeToBlack || R.Bool(Game1.player.FarmerSprite, "PauseForSingleAnimation"))) return;
        var result = FoodActions.Finish(food);
        job = null; current.Completion.TrySetResult(result);
    }
}
