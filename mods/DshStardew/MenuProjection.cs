using System.Collections;
using System.Reflection;
using System.Text.Json;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;

namespace DshStardew;

internal sealed record UiTarget(string Ref, string Path, string Name, string Label, Rectangle Bounds, string Kind);

/// <summary>Project visible native components, never cached screen coordinates from another menu.</summary>
internal sealed class MenuProjection
{
    private IClickableMenu? previous;
    private string epoch = "";
    private readonly Dictionary<string, UiTarget> targets = new();
    private string revision = "";

    private static IClickableMenu? Leaf()
    {
        var menu = Game1.activeClickableMenu;
        for (var depth = 0; depth < 8 && menu?.GetChildMenu() is { } child; depth++) menu = child;
        return menu;
    }

    public object Capture()
    {
        var menu = Leaf();
        if (!ReferenceEquals(menu, previous)) { previous = menu; epoch = Guid.NewGuid().ToString("N"); }
        targets.Clear();
        if (menu is null)
        {
            revision = GameFacts.Hash(JsonSerializer.Serialize(new { epoch, state = GameFacts.ControlState(),
                viewportX = Game1.viewport.X, viewportY = Game1.viewport.Y, zoom = Game1.options.zoomLevel, uiScale = Game1.options.uiScale }, LocalServer.Json));
            if (R.Get(typeof(Game1), "currentMinigame") is null && !Game1.eventUp)
                AddWorldTargets((int)Game1.player.Tile.X - 6, (int)Game1.player.Tile.Y - 6, (int)Game1.player.Tile.X + 6, (int)Game1.player.Tile.Y + 6);
            return new { revision, menuType = (string?)null, components = ProjectTargets(), context = GameFacts.ControlState(),
                note = "Nearby visible world targets are for dsh_input.target; tile visibility does not imply reachability or an actionable object." };
        }
        var viewport = new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height);
        var components = new List<(string path, ClickableComponent component)>();
        var seen = new HashSet<object>();
        void Visit(object source, string path, int depth)
        {
            if (depth > 5 || components.Count >= 512 || !seen.Add(source)) return;
            if (source is ClickableComponent component)
            {
                if (component.visible && component.bounds.Width > 0 && component.bounds.Height > 0 && viewport.Intersects(component.bounds)) components.Add((path, component));
                return;
            }
            if (source is IEnumerable list && source is not string)
            {
                var i = 0;
                foreach (var entry in list) { if (entry is not null) Visit(entry, $"{path}[{i}]", depth + 1); if (++i >= 512) break; }
                return;
            }
            if (!(source.GetType().Namespace?.StartsWith("StardewValley.Menus", StringComparison.Ordinal) ?? false)) return;
            foreach (var field in source.GetType().GetFields(R.Flags).Where(f => !f.IsStatic).OrderBy(f => f.Name))
            {
                var value = field.GetValue(source);
                if (value is ClickableComponent || value is IEnumerable || value is IClickableMenu)
                    if (value is not null) Visit(value, $"{path}.{field.Name}", depth + 1);
            }
        }
        Visit(menu, "menu", 0);
        // GameMenu owns hidden pages too; project only its actual current page plus its visible tabs.
        if (menu is GameMenu gameMenu)
        {
            components.Clear(); seen.Clear();
            Visit(gameMenu.tabs, "tabs", 0);
            var pages = R.Items(R.Get(gameMenu, "pages")).ToArray();
            if (gameMenu.currentTab >= 0 && gameMenu.currentTab < pages.Length) Visit(pages[gameMenu.currentTab], "page", 0);
            if (menu.upperRightCloseButton is { } close) Visit(close, "close", 0);
        }
        var componentState = components.Select(e => new { e.path, e.component.name, e.component.label, bounds = R.Plain(e.component.bounds), item = e.component.item?.QualifiedItemId, count = e.component.item?.Stack }).ToArray();
        var state = R.Scalars(menu);
        var actionState = R.Fields(menu, "currentTab", "currentItemIndex", "whichArea", "specificBundlePage", "scrambledText", "canClick", "onFarm", "Action", "freeze", "isQuestion", "transitioning");
        var details = R.Fields(menu, "Blueprint", "currentBuilding", "heldItem", "currentPageBundle", "ingredientList", "ingredients", "whichArea", "forSale", "itemPriceAndStock", "selectedItemIndex", "currentItemIndex", "selectedAnimal", "animalBeingPurchased", "onFarm", "freeze", "canClick");
        revision = GameFacts.Hash(JsonSerializer.Serialize(new {
            epoch, type = menu.GetType().FullName, componentState, actionState, details,
            viewport = new { x = Game1.viewport.X, y = Game1.viewport.Y, width = Game1.viewport.Width, height = Game1.viewport.Height },
            zoom = Game1.options.zoomLevel, uiScale = Game1.options.uiScale,
            dialogue = menu is DialogueBox box ? box.getCurrentString() : null,
            stateOfPlayer = GameFacts.ControlState(),
        }, LocalServer.Json));
        foreach (var (path, component) in components)
        {
            var reference = GameFacts.Hash($"{revision}|{path}");
            targets[reference] = new UiTarget(reference, path, component.name ?? "", component.label ?? "", component.bounds, "component");
        }
        // Placement is a real world-surface click on the visible farm, not an inventory button.
        // Keep it restricted to the game's own CarpenterMenu placement state.
        if (menu.GetType().Name == "CarpenterMenu" && R.Bool(menu, "onFarm"))
        {
            AddWorldTargets(Game1.viewport.X / 64, Game1.viewport.Y / 64, (Game1.viewport.X + Game1.viewport.Width) / 64, (Game1.viewport.Y + Game1.viewport.Height) / 64);
        }
        return new {
            revision, menuType = menu.GetType().FullName,
            projection = "visible_components_and_selected_native_state", completeness = "partial",
            state, details, visibilityBasis = "component.visible and viewport intersection; cached controls may still require native handler checks",
            components = ProjectTargets(),
            dialogue = menu is DialogueBox dialogue ? dialogue.getCurrentString() : null,
            warning = "Native game handlers validate costs, placement and eligibility. A visible component does not prove a full gameplay workflow is supported.",
        };
    }

    private object[] ProjectTargets() => targets.Values.Select(t => (object)new { reference = t.Ref, t.Name, t.Label, t.Kind, bounds = R.Plain(t.Bounds) }).ToArray();

    private void AddWorldTargets(int minX, int minY, int maxX, int maxY)
    {
        var scale = Game1.options.uiScale / Game1.options.zoomLevel;
        var viewport = new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height);
        for (var x = Math.Max(0, minX); x <= maxX; x++)
        for (var y = Math.Max(0, minY); y <= maxY; y++)
        {
            var bounds = new Rectangle((int)((x * 64 - Game1.viewport.X) / scale), (int)((y * 64 - Game1.viewport.Y) / scale), Math.Max(1, (int)(64 / scale)), Math.Max(1, (int)(64 / scale)));
            if (!viewport.Contains(bounds.Center)) continue;
            var reference = GameFacts.Hash($"{revision}|tile:{x}:{y}");
            targets[reference] = new UiTarget(reference, $"tile:{x}:{y}", $"{x},{y}", "visible tile; native range and validity checks still apply", bounds, "world_tile");
        }
    }

    public bool Matches(string expected) { Capture(); return expected.Length > 0 && expected == revision; }

    public Point PositionPointer(JsonElement args)
    {
        if (!Matches(R.Arg(args, "revision")) || !targets.TryGetValue(R.Arg(args, "target"), out var target)) throw new InvalidOperationException("stale_ui: query the visible target again");
        var point = target.Bounds.Center;
        // CarpenterMenu reads getOldMouseX(false), not just receiveLeftClick's x/y arguments.
        // UI coordinates must pass through the game's UI scale, then wait for both mouse snapshots.
        Game1.setMousePosition(point.X, point.Y, true);
        return point;
    }

    public object Act(JsonElement args)
    {
        var expected = R.Arg(args, "revision");
        if (!Matches(expected)) throw new InvalidOperationException("stale_ui: query the current UI again");
        var menu = Leaf() ?? throw new InvalidOperationException("No active native menu");
        var operation = R.Arg(args, "operation", "click");
        if (operation == "key")
        {
            var key = R.Arg(args, "key");
            if (!new[] { "Escape", "Enter", "Space", "Up", "Down", "Left", "Right", "Tab", "Delete" }.Contains(key)) throw new ArgumentException("Unsupported menu key");
            menu.receiveKeyPress(Enum.Parse<Keys>(key));
        }
        else if (operation == "scroll") menu.receiveScrollWheelAction(R.Int(args, "delta", -120, -480, 480));
        else
        {
            if (!targets.TryGetValue(R.Arg(args, "target"), out var target)) throw new InvalidOperationException("Unknown visible target; query again");
            var point = target.Bounds.Center;
            menu.performHoverAction(point.X, point.Y);
            if (operation == "right_click") menu.receiveRightClick(point.X, point.Y, true);
            else if (operation == "click")
            {
                menu.receiveLeftClick(point.X, point.Y, true);
                if (ReferenceEquals(Leaf(), menu)) menu.releaseLeftClick(point.X, point.Y);
            }
            else throw new ArgumentException("Unsupported UI operation");
        }
        return new { submitted = true, confirmedOutcome = false, after = Capture(), note = "Inspect the resulting UI, inventory and progress to confirm the intended effect." };
    }

}
