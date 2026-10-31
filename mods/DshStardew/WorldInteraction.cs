using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace DshStardew;

/// <summary>One configured native action edge, after cursor snapshots agree.
/// Chest/ShippingBin handlers check didPlayerJustRightClick; calling checkAction
/// directly does not create that edge. Never force an input state or resend it.</summary>
internal sealed class WorldInteraction
{
    private Point pointer;
    private readonly int x, y;
    private readonly string actor;
    private string display;
    public bool Pressed { get; private set; }
    private static string ActorKey() => $"{Game1.player.Tile}|{Game1.player.FacingDirection}|{Game1.player.CurrentToolIndex}";
    private static string DisplayKey() => $"{Game1.viewport.X}|{Game1.viewport.Y}|{Game1.viewport.Width}|{Game1.viewport.Height}|{Game1.uiViewport.Width}|{Game1.uiViewport.Height}|{Game1.options.uiScale}|{Game1.options.zoomLevel}";
    private WorldInteraction(int x, int y, Point pointer) { this.x = x; this.y = y; this.pointer = pointer; actor = ActorKey(); display = DisplayKey(); }
    private static Point Pointer(int x, int y)
    {
        var scale = Game1.options.uiScale / Game1.options.zoomLevel;
        InventoryActions.Require(float.IsFinite(scale) && scale > 0, "Native world/UI scale is unavailable");
        var p = new Point((int)((x * 64 + 32 - Game1.viewport.X) / scale), (int)((y * 64 + 32 - Game1.viewport.Y) / scale));
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Native world target is off screen"); return p;
    }
    public static WorldInteraction Begin(int x, int y, int slot)
    {
        InventoryActions.Require(Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool
            && slot >= 0 && slot < Game1.player.Items.Count && (Game1.player.Items[slot] is null || Game1.player.Items[slot] is Tool), "Native world interaction requires an actual empty/tool slot");
        var dx = x - (int)Game1.player.Tile.X; var dy = y - (int)Game1.player.Tile.Y;
        InventoryActions.Require(Math.Abs(dx) + Math.Abs(dy) == 1, "Stand exactly adjacent to the actual target");
        var p = Pointer(x, y);
        Game1.player.CurrentToolIndex = slot; Game1.player.faceDirection(dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0);
        Game1.setMousePosition(p.X, p.Y, true);
        return new WorldInteraction(x, y, p);
    }
    public void Tick(IModHelper helper, SButton action)
    {
        if (Pressed) return;
        InventoryActions.Require(ActorKey() == actor && Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool
            && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null, "Native action context changed before input");
        // Camera easing can continue after navigation finishes. Reproject the
        // same tile before submission; never follow a changed actor or target.
        if (display != DisplayKey()) { pointer = Pointer(x, y); display = DisplayKey(); Game1.setMousePosition(pointer.X, pointer.Y, true); return; }
        if (helper.Input.IsDown(action) || Math.Abs(Game1.getMouseX(true) - pointer.X) > 2 || Math.Abs(Game1.getMouseY(true) - pointer.Y) > 2
            || Math.Abs(Game1.getOldMouseX(true) - pointer.X) > 2 || Math.Abs(Game1.getOldMouseY(true) - pointer.Y) > 2) return;
        Pressed = true;
        helper.Input.Press(action); // SMAPI 4.5.2: one tick. Observe only from here onward.
    }
}
