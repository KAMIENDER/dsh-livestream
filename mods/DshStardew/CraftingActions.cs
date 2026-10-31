using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Inventories;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Objects;

namespace DshStardew;

/// <summary>Use the real crafting/cooking page; never create output or update recipes/stats ourselves.</summary>
internal static class CraftingActions
{
    private sealed class Token { public readonly string Value = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Token> Tokens = new();
    private static string Ref(object value) => Tokens.GetValue(value, _ => new Token()).Value;
    private static bool Supported => typeof(Farmer).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    internal sealed record Source(string SourceId, string SourceKind, IInventory Inventory);
    internal sealed record Loss(string SourceId, string SourceKind, string ItemId, int Quality, long Amount);
    internal sealed record SourceView(string SourceId, string SourceKind, string Digest, InventoryActions.Count[] Items);
    internal sealed record RecipeTarget(int PageIndex, ClickableTextureComponent Component, CraftingRecipe Recipe, string Key);
    internal sealed class Attempt
    {
        public string Operation = "", Revision = "";
        public JsonElement Args;
        public IClickableMenu? Root;
        public WorldInteraction? World;
        public CraftingPage? Page;
        public RecipeTarget? Target;
        public Point? Pointer;
        public Source[] Sources = Array.Empty<Source>();
        public SourceView[] Before = Array.Empty<SourceView>();
        public InventoryActions.Count? BeforeHeld;
        public Loss[] Planned = Array.Empty<Loss>();
        public string[] PossibleOutputs = Array.Empty<string>();
        public int Gold, Counter, PageNumber, InteractionSlot = -1;
        public Dictionary<string, int> Cooked = new();
        public bool NativeAccepted = true, Submitted, Seasoning;
    }
    private sealed class Slot { public Item Item = null!; public int Count; public Source Source = null!; }
    private static CraftingPage? Page()
    {
        var root = Game1.activeClickableMenu;
        if (root?.GetChildMenu() is not null) return null;
        if (root?.GetType() == typeof(CraftingPage)) return (CraftingPage)root;
        if (root?.GetType() != typeof(GameMenu)) return null;
        var menu = (GameMenu)root;
        return menu.currentTab == GameMenu.craftingTab && menu.currentTab >= 0 && menu.currentTab < menu.pages.Count
            && menu.pages[menu.currentTab].GetType() == typeof(CraftingPage) ? (CraftingPage)menu.pages[menu.currentTab] : null;
    }
    private static Source[] Sources(CraftingPage page)
    {
        InventoryActions.Require(ReferenceEquals(page.inventory.actualInventory, Game1.player.Items), "Native output inventory is not the actual player inventory");
        var result = new List<Source> { new("player", "player", Game1.player.Items) };
        InventoryActions.Require((page._materialContainers?.Count ?? 0) <= 64, "Native material container set exceeds supported bounded capture");
        foreach (var inventory in page._materialContainers ?? new List<IInventory>())
        {
            InventoryActions.Require(inventory is not null && inventory.GetType() == typeof(Inventory)
                && !result.Any(source => ReferenceEquals(source.Inventory, inventory)), "Unknown or aliased native material inventory");
            result.Add(new Source(Ref(inventory!), "containers", inventory!));
        }
        InventoryActions.Require(result.Sum(source => (long)source.Inventory.Count) <= 16384, "Native source slot count exceeds supported capture");
        var seen = new HashSet<Item>(ReferenceEqualityComparer.Instance);
        foreach (var source in result) foreach (var item in source.Inventory.Where(item => item is not null))
            InventoryActions.Require(item.GetType().Assembly == typeof(Item).Assembly && seen.Add(item), "Custom or aliased item needs an explicit crafting adapter");
        return result.ToArray();
    }
    private static InventoryActions.Count[] Counts(IEnumerable<Item> items) => items.Where(item => item is not null)
        .GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(group => new InventoryActions.Count(group.Key.QualifiedItemId, group.Key.Quality, group.Sum(item => (long)item.Stack)))
        .OrderBy(row => row.ItemId, StringComparer.Ordinal).ThenBy(row => row.Quality).ToArray();
    private static SourceView[] Views(Source[] sources) => sources.Select(source => new SourceView(source.SourceId, source.SourceKind,
        GameFacts.Hash(JsonSerializer.Serialize(source.Inventory.Select((item, slot) => new { slot, item = item is null ? null : new {
            reference = Ref(item), item.QualifiedItemId, item.Quality, item.Stack, item.Category } }), LocalServer.Json)), Counts(source.Inventory))).ToArray();
    private static object? Held(Item? item) => item is null ? null : new { itemId = item.QualifiedItemId, quality = item.Quality, count = item.Stack };
    private static InventoryActions.Count? HeldCount(Item? item) => item is null ? null : new(item.QualifiedItemId, item.Quality, item.Stack);
    private static RecipeTarget[] Recipes(CraftingPage page)
    {
        InventoryActions.Require(page.pagesOfCraftingRecipes.Count <= 128 && page.pagesOfCraftingRecipes.Sum(rows => rows.Count) <= 4096, "Native recipe page capture exceeds bounds");
        return page.pagesOfCraftingRecipes.SelectMany((rows, index) => rows.Select(pair => {
            InventoryActions.Require(pair.Key.GetType() == typeof(ClickableTextureComponent) && pair.Value.GetType() == typeof(CraftingRecipe), "Custom recipe/component needs an adapter");
            return new RecipeTarget(index, pair.Key, pair.Value, GameFacts.Hash($"{Ref(page)}:{index}:{Ref(pair.Key)}:{Ref(pair.Value)}"));
        })).ToArray();
    }
    private static string[] Outputs(CraftingRecipe recipe) => recipe.itemToProduce.Select(raw => {
        var id = recipe.bigCraftable ? ItemRegistry.ManuallyQualifyItemId(raw, "(BC)", false) : raw;
        var data = ItemRegistry.GetDataOrErrorItem(id);
        InventoryActions.Require(!data.IsErrorItem, "Recipe output data is unavailable");
        return data.QualifiedItemId;
    }).Distinct(StringComparer.Ordinal).ToArray();
    private static bool Known(CraftingPage page, CraftingRecipe recipe) => (page.cooking ? Game1.player.cookingRecipes : Game1.player.craftingRecipes).ContainsKey(recipe.name);
    private static int Counter(CraftingRecipe recipe) => Game1.player.craftingRecipes.TryGetValue(recipe.name, out var count) ? count : 0;
    private static Dictionary<string, int> Cooked() => Game1.player.recipesCooked.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    private static Loss[]? Plan(CraftingRecipe recipe, Source[] sources, out bool seasoning)
    {
        InventoryActions.Require(Supported && recipe.recipeList.Count is > 0 and <= 64 && recipe.recipeList.All(pair => pair.Value is > 0 and <= 10000)
            && recipe.numberProducedPerCraft is > 0 and <= 999, "Recipe/build needs a consumption-rule audit");
        var slots = sources.SelectMany(source => source.Inventory.Reverse().Where(item => item is not null).Select(item => new Slot { Source = source, Item = item, Count = item.Stack })).ToArray();
        // Mirrors this build's reverse-slot / player-first / container-order allocation
        // using counts only. Never call createItem/GetItemData(false) to preview RNG.
        InventoryActions.Require(!recipe.isCookingRecipe || Outputs(recipe).All(id => id.StartsWith("(O)", StringComparison.Ordinal)), "Non-object cooking output needs an adapter");
        seasoning = recipe.isCookingRecipe
            && slots.Any(slot => slot.Count > 0 && CraftingRecipe.ItemMatchesForCrafting(slot.Item, "917"));
        var planned = new List<Loss>();
        foreach (var pair in recipe.recipeList.Concat(seasoning ? new[] { new KeyValuePair<string, int>("917", 1) } : Array.Empty<KeyValuePair<string, int>>()))
        {
            var left = pair.Value;
            foreach (var slot in slots)
            {
                if (slot.Count <= 0 || !CraftingRecipe.ItemMatchesForCrafting(slot.Item, pair.Key)) continue;
                var take = Math.Min(left, slot.Count); slot.Count -= take; left -= take;
                planned.Add(new Loss(slot.Source.SourceId, slot.Source.SourceKind, slot.Item.QualifiedItemId, slot.Item.Quality, take));
                if (left == 0) break;
            }
            if (left != 0) return null;
        }
        return planned.GroupBy(row => (row.SourceId, row.SourceKind, row.ItemId, row.Quality))
            .Select(group => new Loss(group.Key.SourceId, group.Key.SourceKind, group.Key.ItemId, group.Key.Quality, group.Sum(row => row.Amount))).ToArray();
    }
    private static string Revision(CraftingPage? page, SourceView[] sources) => GameFacts.Hash(JsonSerializer.Serialize(new {
        save = GameFacts.SaveId(), date = GameFacts.DayKey(), location = Game1.currentLocation.NameOrUniqueName, tile = R.Plain(Game1.player.Tile),
        root = Game1.activeClickableMenu is { } root ? Ref(root) : null, page = page is null ? null : Ref(page),
        pageNumber = page?.currentCraftingPage, cooking = page?.cooking, held = Held(page?.heldItem), sources,
        gold = Game1.player.Money, health = Game1.player.health, energy = Game1.player.Stamina,
        inventoryDigest = InventoryActions.Digest(),
        zoom = Game1.options.zoomLevel, uiScale = Game1.options.uiScale, width = Game1.uiViewport.Width, height = Game1.uiViewport.Height,
        recipes = page is null ? null : Recipes(page).Select(target => new { target.Key, target.PageIndex, target.Component.bounds,
            target.Component.visible, componentName = target.Component.name, recipeName = target.Recipe.name, target.Recipe.recipeList, target.Recipe.itemToProduce, target.Recipe.numberProducedPerCraft,
            known = Known(page, target.Recipe), counter = Counter(target.Recipe) }).ToArray(), cooked = page?.cooking == true ? Cooked() : null,
    }, LocalServer.Json));
    private static string? StationKind(int x, int y)
    {
        if (Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var item) && item.GetType() == typeof(Workbench)) return "workbench";
        // FarmHouse.checkAction handles the fridge tile before dispatching Kitchen.
        // It opens storage, so do not advertise it as a cooking entry.
        if (Game1.currentLocation is FarmHouse && Game1.currentLocation.getTileIndexAt(x, y, "Buildings", "untitled tile sheet") == 173) return null;
        var action = Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false);
        return action is "kitchen" or "Kitchen" ? "kitchen" : null;
    }
    private static string StationDigest(int x, int y) => GameFacts.Hash(JsonSerializer.Serialize(new {
        location = Game1.currentLocation.NameOrUniqueName, x, y, kind = StationKind(x, y),
        item = Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var item) ? Ref(item) : null,
        action = Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false),
    }, LocalServer.Json));
    private static (int X, int Y) Position(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == Game1.currentLocation.NameOrUniqueName, "Use a current-location station position");
        var x = R.Int(p, "x", -1, 0, 10000); var y = R.Int(p, "y", -1, 0, 10000); var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(x < layer.LayerWidth && y < layer.LayerHeight, "Station is outside the loaded map"); return (x, y);
    }
    public static object Query(JsonElement args)
    {
        var page = Page(); var sources = page is null ? Array.Empty<Source>() : Sources(page); var views = Views(sources);
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 30, 1, 100); var name = R.Arg(args, "recipeName");
        var targets = page is null ? Array.Empty<RecipeTarget>() : Recipes(page).Where(target => name.Length == 0 || target.Recipe.name == name).ToArray();
        var recipes = targets.Skip(offset).Take(limit).Select(target => {
            var recipe = target.Recipe; var seasoning = false; var planned = Supported ? Plan(recipe, sources, out seasoning) : null;
            return new { recipeKey = target.Key, recipeName = recipe.name, recipe.DisplayName, target.PageIndex,
                visible = target.PageIndex == page!.currentCraftingPage && target.Component.visible && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(target.Component.bounds.Center),
                known = Known(page!, recipe), ghosted = target.Component.name == "ghosted", recipe.numberProducedPerCraft, recipe.recipeList,
                possibleOutputIds = Outputs(recipe), plannedLosses = planned, seasoningWillApply = seasoning,
                counter = Counter(recipe), cooking = page!.cooking, bounds = R.Plain(target.Component.bounds) };
        }).ToArray();
        object[] stations = Array.Empty<object>();
        if (page is null && Game1.activeClickableMenu is null)
        {
            var minX = Math.Max(0, (int)Game1.player.Tile.X - 6); var minY = Math.Max(0, (int)Game1.player.Tile.Y - 6);
            var spots = args.TryGetProperty("position", out _) ? new[] { Position(args) } :
                Enumerable.Range(minX, (int)Game1.player.Tile.X + 7 - minX).SelectMany(x => Enumerable.Range(minY, (int)Game1.player.Tile.Y + 7 - minY).Select(y => (X: x, Y: y))).ToArray();
            stations = spots.Where(spot => spot.X < Game1.currentLocation.Map.Layers[0].LayerWidth && spot.Y < Game1.currentLocation.Map.Layers[0].LayerHeight)
                .Where(spot => StationKind(spot.X, spot.Y) is not null).Select(spot => (object)new { position = new { locationId = Game1.currentLocation.NameOrUniqueName, x = spot.X, y = spot.Y },
                    kind = StationKind(spot.X, spot.Y), stationDigest = StationDigest(spot.X, spot.Y), adjacent = Math.Abs(Game1.player.Tile.X - spot.X) + Math.Abs(Game1.player.Tile.Y - spot.Y) <= 1 }).ToArray();
        }
        return new { revision = Revision(page, views), pageId = page is null ? null : Ref(page), ready = page is not null, supportedBuild = Supported,
            mode = page is null ? null : page.cooking ? "cooking" : "crafting", menuType = Game1.activeClickableMenu?.GetType().FullName,
            currentPage = page?.currentCraftingPage, totalPages = page?.pagesOfCraftingRecipes.Count, held = Held(page?.heldItem), sources = views,
            emptyPlayerSlots = page?.inventory.inventory.Select((component, index) => new { component, index }).Where(row => row.index < Game1.player.Items.Count && Game1.player.Items[row.index] is null && row.component.visible
                && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(row.component.bounds.Center)).Select(row => row.index).ToArray(),
            recipes, count = targets.Length, offset, nextOffset = offset + limit < targets.Length ? (int?)(offset + limit) : null,
            stations, gold = Game1.player.Money, inventoryDigest = InventoryActions.Digest(), cooked = page?.cooking == true ? Cooked() : null,
            note = "Real native page and its own locked material inventories. Plan is read-only for this build, including reverse-slot/category/wild-seed allocation and automatic Qi seasoning. No output RNG is previewed. IDs are live references, not durable resources. Source capture is bounded to64 containers/16384 slots/128 recipe pages." };
    }
    internal static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(Supported && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null && Game1.player.health > 0, "Unsupported build or non-idle transition");
        var page = Page(); var sources = page is null ? Array.Empty<Source>() : Sources(page); var before = Views(sources);
        var revision = Revision(page, before);
        InventoryActions.Require(R.Arg(args, "revision") == revision, "Crafting context changed; requery before action");
        var attempt = new Attempt { Operation = R.Arg(args, "operation"), Args = args.Clone(), Root = Game1.activeClickableMenu, Page = page,
            Revision = revision, Sources = sources, Before = before, BeforeHeld = HeldCount(page?.heldItem), Gold = Game1.player.Money, Cooked = Cooked(), PageNumber = page?.currentCraftingPage ?? -1 };
        if (attempt.Operation is "open_backpack" or "open_station")
        {
            InventoryActions.Require(page is null && attempt.Root is null && Context.CanPlayerMove && !Game1.player.UsingTool, "Open only from idle world");
            InventoryActions.Require(R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "Player inventory changed before opening");
            if (attempt.Operation == "open_station") { var p = Position(args); InventoryActions.Require(StationKind(p.X, p.Y) is not null && StationDigest(p.X, p.Y) == R.Arg(args, "stationDigest")
                && Math.Abs(Game1.player.Tile.X - p.X) + Math.Abs(Game1.player.Tile.Y - p.Y) == 1, "Stand adjacent to the unchanged actual queried station");
                attempt.InteractionSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(index => Game1.player.Items[index] is null || Game1.player.Items[index] is Tool, -1);
                InventoryActions.Require(attempt.InteractionSlot >= 0, "No empty/tool slot for normal station interaction"); }
            return attempt;
        }
        InventoryActions.Require(page is not null && !Game1.player.UsingTool, "No supported native crafting/cooking page");
        if (attempt.Operation == "craft")
        {
            InventoryActions.Require(page!.heldItem is null && R.Int(args, "maxCount", 1, 1, 1) == 1 && R.Arg(args, "mode") == (page.cooking ? "cooking" : "crafting"), "Use one craft in the exact actual mode with empty cursor");
            attempt.Target = Recipes(page).SingleOrDefault(target => target.Key == R.Arg(args, "recipeKey"));
            var target = attempt.Target;
            InventoryActions.Require(target is not null && target.PageIndex == page.currentCraftingPage && target.Component.visible && target.Component.name != "ghosted"
                && target.Recipe.isCookingRecipe == page.cooking && Known(page, target.Recipe), "Recipe must be learned and on the current visible page in the exact native mode");
            attempt.Planned = Plan(target!.Recipe, sources, out var seasoning) ?? throw new PreconditionRejectedException("Materials/seasoning are insufficient"); attempt.Seasoning = seasoning;
            InventoryActions.Require(target.Recipe.doesFarmerHaveIngredientsInInventory(sources.Skip(1).SelectMany(source => source.Inventory).Where(item => item is not null).ToList()), "Native recipe eligibility rejected the current materials");
            InventoryActions.Require(!seasoning || args.TryGetProperty("allowSeasoning", out var allow) && allow.ValueKind == JsonValueKind.True, "Native Qi seasoning would be consumed; explicit permission is needed");
            CheckBudget(args, attempt.Planned);
            attempt.PossibleOutputs = Outputs(target.Recipe); attempt.Counter = Counter(target.Recipe);
            InventoryActions.Require(attempt.PossibleOutputs.Length > 0 && page.inventory.inventory.Select((component, index) => index < Game1.player.Items.Count && Game1.player.Items[index] is null && component.visible
                && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(component.bounds.Center)).Any(empty => empty), "Reserve an empty visible native output slot before crafting");
            attempt.Pointer = target.Component.bounds.Center;
            InventoryActions.Require(!page.inventory.inventory.Any(component => component.containsPoint(attempt.Pointer.Value.X, attempt.Pointer.Value.Y)), "Recipe target overlaps inventory");
        }
        else if (attempt.Operation == "store")
        {
            var slot = R.Int(args, "destinationSlot", -1, 0, Math.Min(Game1.player.Items.Count, page!.inventory.inventory.Count) - 1);
            InventoryActions.Require(page.heldItem is { } held && held.QualifiedItemId == R.Arg(args, "expectedItemId") && held.Quality == R.Int(args, "expectedQuality", -1, 0, 4)
                && held.Stack == R.Int(args, "expectedCount", 0, 1, 999) && Game1.player.Items[slot] is null && page.inventory.inventory[slot].visible, "Store only the exact held output into an empty native slot");
            attempt.Pointer = page.inventory.inventory[slot].bounds.Center;
        }
        else if (attempt.Operation is "next_page" or "previous_page")
        {
            InventoryActions.Require(page!.heldItem is null, "Do not change pages with a held item"); var next = attempt.Operation == "next_page";
            InventoryActions.Require(next ? page.currentCraftingPage + 1 < page.pagesOfCraftingRecipes.Count : page.currentCraftingPage > 0, "No requested adjacent recipe page");
            attempt.Pointer = (next ? page.downButton : page.upButton).bounds.Center;
        }
        else InventoryActions.Require(attempt.Operation == "close" && page!.heldItem is null && page.readyToClose() && attempt.Root!.readyToClose(), "Only close a known empty-cursor native page");
        if (attempt.Pointer is { } point) InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(point), "Target is not currently visible");
        if (attempt.Pointer is { } pointer && attempt.Operation != "craft")
        {
            // A native left-click also checks inventory, recipes, trash and arrows.
            // Reject ambiguous layout intersections before one click can do two actions.
            InventoryActions.Require(!Recipes(page!).Any(target => target.PageIndex == page!.currentCraftingPage
                && new Rectangle(target.Component.bounds.X - 4, target.Component.bounds.Y - 4, target.Component.bounds.Width + 8, target.Component.bounds.Height + 8).Contains(pointer))
                && (page!.trashCan is null || !page.trashCan.containsPoint(pointer.X, pointer.Y)), "Native target overlaps a recipe or trash action");
            if (attempt.Operation != "store") InventoryActions.Require(!page.inventory.inventory.Any(component => component.containsPoint(pointer.X, pointer.Y)), "Page arrow overlaps inventory");
            else InventoryActions.Require((page.upButton is null || !page.upButton.containsPoint(pointer.X, pointer.Y)) && (page.downButton is null || !page.downButton.containsPoint(pointer.X, pointer.Y)), "Output slot overlaps page arrows");
        }
        return attempt;
    }
    private static void CheckBudget(JsonElement args, Loss[] losses)
    {
        InventoryActions.Require(args.TryGetProperty("materialBudget", out var rows) && rows.ValueKind == JsonValueKind.Array && rows.GetArrayLength() is > 0 and <= 128, "Use an explicit source-kind/item/quality material budget");
        var limits = new Dictionary<(string, string, int), int>();
        foreach (var row in rows.EnumerateArray())
        {
            var kind = R.Arg(row, "sourceKind"); var id = R.Arg(row, "itemId"); var quality = R.Int(row, "quality", -1, 0, 4);
            InventoryActions.Require((kind is "player" or "containers") && id.Length is > 0 and <= 160 && limits.TryAdd((kind, id, quality), R.Int(row, "maxCount", 0, 1, 10000)), "Invalid/duplicate material budget");
        }
        foreach (var group in losses.GroupBy(row => (row.SourceKind, row.ItemId, row.Quality))) InventoryActions.Require(group.Sum(row => row.Amount) <= limits.GetValueOrDefault(group.Key), "Native material allocation exceeds the explicit budget");
    }
    internal static bool ContextMatches(Attempt attempt) => ReferenceEquals(Game1.activeClickableMenu, attempt.Root) && ReferenceEquals(Page(), attempt.Page)
        && Revision(attempt.Page, Views(attempt.Sources)) == attempt.Revision;
    internal static void Execute(Attempt attempt)
    {
        InventoryActions.Require(ContextMatches(attempt), "Crafting context changed before native handler");
        attempt.Submitted = true;
        if (attempt.Operation == "open_backpack") GameLocation.openCraftingMenu();
        else if (attempt.Operation == "open_station")
        {
            var p = Position(attempt.Args);
            if (StationDigest(p.X, p.Y) != R.Arg(attempt.Args, "stationDigest")) throw new InvalidOperationException("Station changed before native interaction");
            attempt.World = WorldInteraction.Begin(p.X, p.Y, attempt.InteractionSlot);
            attempt.Revision = Revision(attempt.Page, Views(attempt.Sources)); attempt.NativeAccepted = true;
        }
        else if (attempt.Operation == "close") attempt.Root!.exitThisMenu();
        else if (attempt.Operation == "craft") attempt.Page!.receiveRightClick(attempt.Pointer!.Value.X, attempt.Pointer.Value.Y, true);
        else attempt.Page!.receiveLeftClick(attempt.Pointer!.Value.X, attempt.Pointer.Value.Y, true);
    }
    internal static bool WaitingForOpen(Attempt attempt) => (attempt.Operation is "open_backpack" or "open_station") && attempt.NativeAccepted && Page() is null;
    private static Loss[] Changes(SourceView[] before, SourceView[] after, InventoryActions.Count? beforeHeld, Item? afterHeld)
    {
        var oldRows = before.SelectMany(source => source.Items.Select(item => new Loss(source.SourceId, source.SourceKind, item.ItemId, item.Quality, item.Amount))).ToList();
        var nowRows = after.SelectMany(source => source.Items.Select(item => new Loss(source.SourceId, source.SourceKind, item.ItemId, item.Quality, item.Amount))).ToList();
        if (beforeHeld is not null) oldRows.Add(new Loss("cursor", "cursor", beforeHeld.ItemId, beforeHeld.Quality, beforeHeld.Amount));
        if (afterHeld is not null) nowRows.Add(new Loss("cursor", "cursor", afterHeld.QualifiedItemId, afterHeld.Quality, afterHeld.Stack));
        return nowRows.Concat(oldRows.Select(row => row with { Amount = -row.Amount })).GroupBy(row => (row.SourceId, row.SourceKind, row.ItemId, row.Quality))
            .Select(group => new Loss(group.Key.SourceId, group.Key.SourceKind, group.Key.ItemId, group.Key.Quality, group.Sum(row => row.Amount))).Where(row => row.Amount != 0).ToArray();
    }
    internal static object Finish(Attempt attempt)
    {
        var page = Page(); var samePage = ReferenceEquals(page, attempt.Page) && ReferenceEquals(Game1.activeClickableMenu, attempt.Root);
        var after = Views(attempt.Sources); var changes = Changes(attempt.Before, after, attempt.BeforeHeld, page?.heldItem);
        var moneySame = attempt.Gold == Game1.player.Money; var confirmed = false; object? output = null;
        if (attempt.Operation == "craft" && samePage && moneySame)
        {
            var net = changes.Concat(attempt.Planned).GroupBy(row => (row.SourceId, row.SourceKind, row.ItemId, row.Quality))
                .Select(group => new Loss(group.Key.SourceId, group.Key.SourceKind, group.Key.ItemId, group.Key.Quality, group.Sum(row => row.Amount))).Where(row => row.Amount != 0).ToArray();
            var produced = net.Length == 1 ? net[0] : null; var recipe = attempt.Target!.Recipe;
            var counters = page!.cooking ? Cooked().Concat(attempt.Cooked.Select(row => new KeyValuePair<string, int>(row.Key, -row.Value)))
                .GroupBy(row => row.Key).Where(group => group.Sum(row => row.Value) != 0).ToArray() : null;
            confirmed = produced is not null && (produced.SourceKind is "player" or "cursor") && attempt.PossibleOutputs.Contains(produced.ItemId)
                && produced.Amount == recipe.numberProducedPerCraft && produced.Quality == (attempt.Seasoning ? 2 : 0)
                && (page.cooking ? counters!.Length == 1 && counters[0].Key == produced.ItemId[3..] && counters[0].Sum(row => row.Value) == 1 : Counter(recipe) == attempt.Counter + recipe.numberProducedPerCraft);
            if (confirmed) output = new { produced!.ItemId, produced.Quality, quantity = produced.Amount, destination = produced.SourceKind };
        }
        else if (attempt.Operation == "store" && samePage && moneySame && page!.heldItem is null && attempt.BeforeHeld is { } held)
            confirmed = changes.Length == 2 && changes.Any(row => row.SourceKind == "cursor" && row.ItemId == held.ItemId && row.Quality == held.Quality && row.Amount == -held.Amount)
                && changes.Any(row => row.SourceId == "player" && row.ItemId == held.ItemId && row.Quality == held.Quality && row.Amount == held.Amount);
        else if (attempt.Operation is "next_page" or "previous_page") confirmed = samePage && moneySame && changes.Length == 0
            && page!.currentCraftingPage == attempt.PageNumber + (attempt.Operation == "next_page" ? 1 : -1);
        else if (attempt.Operation == "close") confirmed = Game1.activeClickableMenu is null && moneySame && changes.Length == 0;
        else if (attempt.Operation is "open_backpack" or "open_station") confirmed = page is not null && moneySame && InventoryActions.Digest() == R.Arg(attempt.Args, "inventoryDigest");
        return new { operation = attempt.Operation, nativeActionSubmitted = attempt.Submitted, completedWorkflow = confirmed, confirmedCraft = attempt.Operation == "craft" && confirmed,
            completionUncertain = !confirmed && attempt.Submitted, output, consumed = attempt.Operation == "craft" && confirmed ? attempt.Planned : null,
            recipeName = attempt.Target?.Recipe.name, cooking = page?.cooking, beforeSources = attempt.Before, afterSources = after,
            beforeHeld = attempt.BeforeHeld is null ? null : new { itemId = attempt.BeforeHeld.ItemId, quality = attempt.BeforeHeld.Quality, count = attempt.BeforeHeld.Amount },
            afterHeld = Held(page?.heldItem), inventoryChanges = changes,
            beforeGold = attempt.Gold, afterGold = Game1.player.Money, seasoning = attempt.Seasoning,
            counterBefore = attempt.Counter, counterAfter = attempt.Target is null ? (int?)null : Counter(attempt.Target.Recipe), cookedBefore = attempt.Cooked, cookedAfter = Cooked(),
            note = "One native action. A verified craft may still be on the native cursor; storing and closing are separate, never replay the craft after an unknown result." };
    }
}
