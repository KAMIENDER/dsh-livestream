using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Input;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Native shop facts, access, scroll, sale and close. Ordinary purchases
/// reuse the audited MCP adapter; this class never creates stock or credits money.</summary>
internal static class ShopActions
{
    private sealed class Token { public readonly string Value = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Token> Tokens = new();
    private static string Key(object value) => Tokens.GetValue(value, _ => new Token()).Value;
    private static bool Supported => typeof(Farmer).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    private static ShopMenu? Menu() => Game1.activeClickableMenu?.GetType() == typeof(ShopMenu) && Game1.activeClickableMenu.GetChildMenu() is null ? (ShopMenu)Game1.activeClickableMenu : null;
    private static bool Plain(Item? item) => item?.GetType() == typeof(SObject) && item is SObject obj && !obj.IsRecipe && !obj.isLostItem && !obj.specialItem
        && !obj.Special && obj.QualifiedItemId is not "(O)434" and not "(O)858";
    private static bool Ordinary(ShopMenu menu) => menu.currency == 0 && !menu.readOnly && menu.heldItem is null && menu.safetyTimer <= 0
        && R.Raw(menu, "_isStorageShop") is false && menu.forSale.Count <= 4096;
    private static bool NativeInventory(ShopMenu menu) => menu.inventory.GetType() == typeof(InventoryMenu)
        && ReferenceEquals(menu.inventory.actualInventory, Game1.player.Items) && menu.inventory.inventory.Count <= 256
        && R.Raw(menu.inventory, "highlightMethod") is Delegate highlight && highlight.GetInvocationList().Length == 1 && ReferenceEquals(highlight.Target, menu)
        && highlight.Method.DeclaringType == typeof(ShopMenu) && highlight.Method.Name == nameof(ShopMenu.highlightItemToSell);
    private static float? SellPercentage(ShopMenu menu) => R.Raw(menu, "sellPercentage") is float value && float.IsFinite(value) && value >= 0 ? value : null;
    private static int? UnitPrice(ShopMenu menu, Item item)
    {
        if (!Plain(item) || SellPercentage(menu) is not { } percentage) return null;
        // Match native single-precision multiplication and integer truncation.
        // Do not clone goods or evaluate random purchase/receive behavior in a read.
        var price = item.sellToStorePrice(-1) * percentage;
        return float.IsFinite(price) && price >= 0 && price < int.MaxValue ? checked((int)price) : null;
    }
    private static object Sale(ShopMenu menu, ISalable salable, int index)
    {
        var found = menu.itemPriceAndStock.TryGetValue(salable, out var stock); var item = salable as Item;
        var row = index - menu.currentItemIndex;
        var visible = row >= 0 && row < menu.forSaleButtons.Count && menu.forSaleButtons[row].visible
            && new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(menu.forSaleButtons[row].bounds.Center);
        return new { saleKey = Key(salable), index, itemId = item?.QualifiedItemId, quality = item?.Quality, templateStack = item?.Stack,
            price = found ? (int?)stock.Price : null, stock = found ? (int?)stock.Stock : null,
            unlimited = found && (stock.Stock == ShopMenu.infiniteStock || Plain(item) && item!.IsInfiniteStock()),
            tradeItem = found ? stock.TradeItem : null, purchaseActionCount = found ? stock.ActionsOnPurchase?.Count ?? 0 : (int?)null,
            buyBack = menu.buyBackItems.Contains(salable), visible, bounds = visible ? R.Plain(menu.forSaleButtons[row].bounds) : null,
            compatibleWithAuditedPurchase = Ordinary(menu) && found && Plain(item) && stock.Price >= 0 && stock.Stock >= 0 && item!.Stack > 0
                && menu.canPurchaseCheck is null && menu.onPurchase is null && !menu.buyBackItems.Contains(salable)
                && string.IsNullOrEmpty(stock.TradeItem) && (stock.ActionsOnPurchase?.Count ?? 0) == 0,
        };
    }
    private static Point? SlotPoint(ShopMenu menu, int slot)
    {
        if (!NativeInventory(menu) || slot < 0 || slot >= menu.inventory.inventory.Count || slot >= Game1.player.MaxItems) return null;
        var component = menu.inventory.inventory[slot]; var p = component.bounds.Center;
        if (component.name != slot.ToString(System.Globalization.CultureInfo.InvariantCulture) || !component.visible
            || !new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p)
            || menu.forSaleButtons.Any(c => c.containsPoint(p.X, p.Y)) || menu.tabButtons.Any(c => c.containsPoint(p.X, p.Y))
            || menu.upArrow?.containsPoint(p.X, p.Y) == true || menu.downArrow?.containsPoint(p.X, p.Y) == true
            || menu.scrollBar?.containsPoint(p.X, p.Y) == true || menu.upperRightCloseButton?.containsPoint(p.X, p.Y) == true
            || R.Raw(menu, "scrollBarRunner") is Rectangle runner && runner.Contains(p)) return null;
        return p;
    }
    private static object SellItem(ShopMenu menu, Item item, int slot) => new {
        inventorySlot = slot, itemKey = Key(item), itemId = item.QualifiedItemId, quality = item.Quality, quantity = item.Stack, unitPrice = UnitPrice(menu, item),
        eligible = Ordinary(menu) && NativeInventory(menu) && menu.onSell is null && Plain(item) && UnitPrice(menu, item) is not null
            && menu.highlightItemToSell(item) && SlotPoint(menu, slot) is not null,
    };
    private static string StockDigest(ShopMenu menu) => GameFacts.Hash(JsonSerializer.Serialize(menu.forSale.Select((item, i) => new {
        key = Key(item), i, item = item is Item actual ? new { actual.QualifiedItemId, actual.Quality, actual.Stack, type = actual.GetType().FullName } : null,
        stock = menu.itemPriceAndStock.TryGetValue(item, out var stock) ? new { stock.Price, stock.Stock, stock.TradeItem,
            actions = stock.ActionsOnPurchase?.ToArray(), buyBack = menu.buyBackItems.Contains(item) } : null,
    }), LocalServer.Json));
    private static string Revision() => GameFacts.Hash(JsonSerializer.Serialize(new {
        save = GameFacts.SaveId(), date = GameFacts.DayKey(), location = Game1.currentLocation.NameOrUniqueName, tile = R.Plain(Game1.player.Tile),
        inventory = InventoryActions.Digest(), gold = Game1.player.Money, menuKey = Game1.activeClickableMenu is { } root ? Key(root) : null,
        shop = Menu() is { } menu ? new { menu.ShopId, menu.currency, menu.readOnly, ready = menu.safetyTimer <= 0, menu.currentItemIndex,
            stock = StockDigest(menu), held = menu.heldItem is null ? null : Key(menu.heldItem), storage = R.Raw(menu, "_isStorageShop"),
            nativeInventory = NativeInventory(menu), percentage = SellPercentage(menu),
            onPurchase = menu.onPurchase is null ? null : Key(menu.onPurchase), onSell = menu.onSell is null ? null : Key(menu.onSell),
            canPurchase = menu.canPurchaseCheck is null ? null : Key(menu.canPurchaseCheck),
            inventoryBounds = menu.inventory.inventory.Select(c => new { c.name, c.visible, bounds = R.Plain(c.bounds) }).ToArray(),
            saleBounds = menu.forSaleButtons.Select(c => new { c.visible, bounds = R.Plain(c.bounds) }).ToArray(),
            tabs = menu.tabButtons.Select(c => R.Plain(c.bounds)).ToArray(), arrows = new[] { menu.upArrow, menu.downArrow, menu.scrollBar, menu.upperRightCloseButton }.Select(c => R.Plain(c?.bounds)).ToArray(),
            scrollRunner = R.Plain(R.Raw(menu, "scrollBarRunner")), scrolling = R.Raw(menu, "scrolling"),
        } : null, viewport = new { Game1.uiViewport.Width, Game1.uiViewport.Height },
    }, LocalServer.Json));
    private static (int X, int Y) Position(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == Game1.currentLocation.NameOrUniqueName, "Use an actual current-location shop counter");
        var x = R.Int(p, "x", -1, 0, 10000); var y = R.Int(p, "y", -1, 0, 10000); var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(x < layer.LayerWidth && y < layer.LayerHeight, "Shop counter is outside the current map"); return (x, y);
    }
    private static string? StationShop(int x, int y)
    {
        var action = Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false);
        var parts = action?.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts is { Length: >= 2 and <= 9 } && parts[0] == "OpenShop" ? parts[1] : null;
    }
    private static string StationDigest(int x, int y) => GameFacts.Hash(JsonSerializer.Serialize(new {
        location = Game1.currentLocation.NameOrUniqueName, x, y, action = Game1.currentLocation.doesTileHaveProperty(x, y, "Action", "Buildings", false),
        objectKey = Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var item) ? Key(item) : null,
    }, LocalServer.Json));
    private static bool ClearStation(int x, int y) => !Game1.currentLocation.Objects.ContainsKey(new Vector2(x, y))
        && !Game1.currentLocation.characters.Any(npc => npc.GetBoundingBox().Intersects(new Rectangle(x * 64, y * 64, 64, 64)))
        && !AnimalCare.In(Game1.currentLocation).Any(animal => animal.GetBoundingBox().Intersects(new Rectangle(x * 64, y * 64, 64, 64)));
    public static object Query(JsonElement args)
    {
        var menu = Menu(); InventoryActions.Require(menu is null || menu.forSale.Count <= 4096, "Shop stock exceeds bounded full capture; not returned as complete");
        var stock = menu is null ? Array.Empty<(ISalable Item, int Index)>() : menu.forSale.Select((item, index) => (Item: item, Index: index)).ToArray();
        if (args.TryGetProperty("itemId", out _)) stock = stock.Where(row => row.Item is Item item && item.QualifiedItemId == R.Arg(args, "itemId")
            && (!args.TryGetProperty("quality", out _) || item.Quality == R.Int(args, "quality", -1, 0, 4))).ToArray();
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 20, 1, 100);
        var spots = new List<(int X, int Y)>(); var layer = Game1.currentLocation.Map.Layers[0];
        if (args.TryGetProperty("position", out _)) spots.Add(Position(args));
        else for (var y = Math.Max(0, (int)Game1.player.Tile.Y - 6); y <= Math.Min(layer.LayerHeight - 1, (int)Game1.player.Tile.Y + 6); y++)
            for (var x = Math.Max(0, (int)Game1.player.Tile.X - 6); x <= Math.Min(layer.LayerWidth - 1, (int)Game1.player.Tile.X + 6); x++) spots.Add((x, y));
        return new { supportedBuild = Supported, revision = Revision(), gold = Game1.player.Money, player = InventoryActions.Counts(), inventoryDigest = InventoryActions.Digest(),
            menuType = Game1.activeClickableMenu?.GetType().FullName,
            shop = menu is null ? null : new { menuKey = Key(menu), shopId = menu.ShopId, menu.currency, ordinary = Ordinary(menu), nativeInventory = NativeInventory(menu),
                held = menu.heldItem is null ? null : Key(menu.heldItem), menu.currentItemIndex, visibleRows = menu.forSaleButtons.Count, totalSales = menu.forSale.Count,
                stockDigest = StockDigest(menu), purchaseCallback = menu.onPurchase is not null || menu.canPurchaseCheck is not null, sellCallback = menu.onSell is not null },
            items = menu is null ? Array.Empty<object>() : stock.Skip(offset).Take(limit).Select(row => Sale(menu, row.Item, row.Index)).ToArray(),
            count = stock.Length, offset, nextOffset = offset + limit < stock.Length ? (int?)(offset + limit) : null,
            playerSell = menu is null ? Array.Empty<object>() : Game1.player.Items.Select((item, slot) => (item, slot)).Where(row => row.item is not null).Select(row => SellItem(menu, row.item, row.slot)).ToArray(),
            stations = spots.Where(p => StationShop(p.X, p.Y) is not null).Select(p => new { position = new { locationId = Game1.currentLocation.NameOrUniqueName, x = p.X, y = p.Y },
                shopId = StationShop(p.X, p.Y), stationDigest = StationDigest(p.X, p.Y), clear = ClearStation(p.X, p.Y),
                action = Game1.currentLocation.doesTileHaveProperty(p.X, p.Y, "Action", "Buildings", false),
                adjacent = Math.Abs(Game1.player.Tile.X - p.X) + Math.Abs(Game1.player.Tile.Y - p.Y) == 1 }).ToArray(),
            note = "Actual loaded shop and OpenShop counters only. Native checks owners/hours/conditions. No stock generation, item clone or callback invocation in this query; special currencies, callbacks, buyback and special goods need separate adapters." };
    }
    internal sealed class Attempt
    {
        public string Operation = "", Revision = "", ExpectedShop = "", ItemId = "", ItemKey = "", BeforeStock = "";
        public ShopMenu? Menu; public Item? Item; public JsonElement Args; public Point Pointer;
        public WorldInteraction? World;
        public int Slot = -1, Quantity, Quality, UnitPrice, Gold, StartStack, Sold, StartIndex, InteractionSlot = -1;
        public bool Submitted, NativeAccepted, WholeStack;
        public InventoryActions.Count[] BeforePlayer = Array.Empty<InventoryActions.Count>();
    }
    internal static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(Supported && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null && Game1.player.health > 0, "Shop transition or unsupported game build");
        InventoryActions.Require(R.Arg(args, "revision") == Revision(), "Shop/player state changed; query again");
        var attempt = new Attempt { Operation = R.Arg(args, "operation"), Revision = Revision(), ExpectedShop = R.Arg(args, "expectedShopId"), Args = args.Clone(),
            Menu = Menu(), Gold = Game1.player.Money, BeforePlayer = InventoryActions.Counts() };
        if (attempt.Operation == "open")
        {
            var p = Position(args);
            InventoryActions.Require(Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool && ClearStation(p.X, p.Y)
                && StationShop(p.X, p.Y) == attempt.ExpectedShop && StationDigest(p.X, p.Y) == R.Arg(args, "stationDigest")
                && Math.Abs(Game1.player.Tile.X - p.X) + Math.Abs(Game1.player.Tile.Y - p.Y) == 1, "Stand adjacent to this exact unobstructed native OpenShop counter");
            attempt.InteractionSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(i => Game1.player.Items[i] is null || Game1.player.Items[i] is Tool, -1);
            InventoryActions.Require(attempt.InteractionSlot >= 0, "Need an actual empty/tool slot for counter interaction"); return attempt;
        }
        var menu = attempt.Menu;
        InventoryActions.Require(menu is not null && Key(menu) == R.Arg(args, "menuKey") && menu.ShopId == attempt.ExpectedShop && menu.heldItem is null, "Exact native empty-cursor shop changed");
        attempt.StartIndex = menu!.currentItemIndex; attempt.BeforeStock = StockDigest(menu);
        if (attempt.Operation == "close") { InventoryActions.Require(menu.readyToClose(), "Native shop is not ready to close"); return attempt; }
        InventoryActions.Require(Ordinary(menu), "Only ordinary ready gold shops are supported for these actions");
        if (attempt.Operation is "next_row" or "previous_row")
        {
            InventoryActions.Require(attempt.Operation == "next_row" ? menu.currentItemIndex < Math.Max(0, menu.forSale.Count - 4) : menu.currentItemIndex > 0, "No requested adjacent shop row"); return attempt;
        }
        InventoryActions.Require(attempt.Operation == "sell" && NativeInventory(menu) && menu.onSell is null && R.Raw(menu, "scrolling") is false, "No ordinary native sale context");
        attempt.Slot = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1); attempt.Item = Game1.player.Items[attempt.Slot];
        attempt.Quantity = R.Int(args, "quantity", 0, 1, 10000); attempt.Quality = R.Int(args, "expectedQuality", -1, 0, 4); attempt.ItemId = R.Arg(args, "expectedItemId");
        InventoryActions.Require(attempt.Item is { } item && Plain(item) && item.QualifiedItemId == attempt.ItemId && item.Quality == attempt.Quality
            && Key(item) == R.Arg(args, "itemKey") && item.Stack >= attempt.Quantity && menu.highlightItemToSell(item), "Exact source is not an ordinary accepted sale item");
        attempt.ItemKey = Key(attempt.Item!); attempt.StartStack = attempt.Item!.Stack; attempt.WholeStack = attempt.Quantity == attempt.StartStack;
        InventoryActions.Require(attempt.WholeStack || attempt.Quantity <= 999, "Partial native sale is bounded to 999 units; split into explicitly approved batches");
        // Native sales may add buyback rows. Reserve their worst-case row count
        // before selling rather than discover an oversized capture after payment.
        var maximumStack = attempt.Item.maximumStackSize();
        InventoryActions.Require(maximumStack > 0 && menu.forSale.Count + (long)Math.Ceiling((double)attempt.Quantity / maximumStack) <= 4096,
            "Native buyback additions would exceed the bounded shop capture");
        attempt.UnitPrice = UnitPrice(menu, attempt.Item) ?? throw new PreconditionRejectedException("Native sell price unavailable");
        InventoryActions.Require(attempt.UnitPrice == R.Int(args, "expectedUnitPrice", -1, 0, int.MaxValue) && (long)attempt.Gold + (long)attempt.Quantity * attempt.UnitPrice <= int.MaxValue, "Native sale price changed or would overflow gold");
        attempt.Pointer = SlotPoint(menu, attempt.Slot) ?? throw new PreconditionRejectedException("Sale slot is hidden, ambiguous or overlaps another action");
        InventoryActions.Require(!Game1.oldKBState.IsKeyDown(Keys.LeftShift), "Release native left Shift before an exact quantity sale"); return attempt;
    }
    internal static bool ContextMatches(Attempt attempt) => Revision() == attempt.Revision && (attempt.Operation == "open" || ReferenceEquals(Menu(), attempt.Menu));
    private static bool InventoryMatches(Attempt attempt, int sold)
    {
        var expected = attempt.BeforePlayer.ToDictionary(row => (row.ItemId, row.Quality), row => row.Amount);
        if (sold != 0) expected[(attempt.ItemId, attempt.Quality)] -= sold;
        var actual = InventoryActions.Counts().ToDictionary(row => (row.ItemId, row.Quality), row => row.Amount);
        return expected.Keys.Concat(actual.Keys).Distinct().All(key => expected.GetValueOrDefault(key) == actual.GetValueOrDefault(key));
    }
    internal static void Execute(Attempt attempt)
    {
        InventoryActions.Require(ContextMatches(attempt), "Shop context changed before native action");
        if (attempt.Operation == "sell")
        {
            var menu = attempt.Menu!; var item = Game1.player.Items[attempt.Slot];
            InventoryActions.Require(ReferenceEquals(item, attempt.Item) && item.Stack == attempt.StartStack - attempt.Sold && Ordinary(menu) && menu.onSell is null
                && menu.highlightItemToSell(item) && UnitPrice(menu, item) == attempt.UnitPrice && InventoryMatches(attempt, attempt.Sold)
                && Game1.player.Money == (long)attempt.Gold + (long)attempt.Sold * attempt.UnitPrice && SlotPoint(menu, attempt.Slot) == attempt.Pointer
                && !Game1.oldKBState.IsKeyDown(Keys.LeftShift), "Native sale source, unit price, modifier or budget changed");
            attempt.Submitted = true;
            // Whole stack uses native left click; partial quantity uses one native
            // right click per tick, with the audited half-stack modifier absent.
            if (attempt.WholeStack) menu.receiveLeftClick(attempt.Pointer.X, attempt.Pointer.Y, false);
            else menu.receiveRightClick(attempt.Pointer.X, attempt.Pointer.Y, false);
            attempt.Sold += attempt.WholeStack ? attempt.Quantity : 1;
            InventoryActions.Require(ReferenceEquals(Menu(), menu) && menu.heldItem is null && InventoryMatches(attempt, attempt.Sold)
                && Game1.player.Money == (long)attempt.Gold + (long)attempt.Sold * attempt.UnitPrice
                && (Game1.player.Items[attempt.Slot]?.Stack ?? 0) == attempt.StartStack - attempt.Sold, "Native sale quantity or currency did not match");
            attempt.Revision = Revision(); return;
        }
        attempt.Submitted = true;
        if (attempt.Operation == "open")
        {
            var p = Position(attempt.Args); InventoryActions.Require(StationDigest(p.X, p.Y) == R.Arg(attempt.Args, "stationDigest"), "Shop counter changed");
            attempt.World = WorldInteraction.Begin(p.X, p.Y, attempt.InteractionSlot);
            attempt.Revision = Revision(); attempt.NativeAccepted = true;
        }
        else if (attempt.Operation == "close") attempt.Menu!.exitThisMenu();
        else attempt.Menu!.receiveScrollWheelAction(attempt.Operation == "next_row" ? -1 : 1);
    }
    internal static bool Waiting(Attempt attempt) => attempt.Operation == "open" && attempt.NativeAccepted && Game1.activeClickableMenu is null;
    internal static object Finish(Attempt attempt)
    {
        var menu = Menu(); var unchanged = InventoryMatches(attempt, 0) && Game1.player.Money == attempt.Gold;
        var confirmed = attempt.Operation switch {
            "open" => unchanged && menu is not null && menu.ShopId == attempt.ExpectedShop && menu.heldItem is null,
            "close" => unchanged && Game1.activeClickableMenu is null,
            "sell" => attempt.Sold == attempt.Quantity && ReferenceEquals(menu, attempt.Menu) && menu!.heldItem is null && InventoryMatches(attempt, attempt.Quantity)
                && Game1.player.Money == (long)attempt.Gold + (long)attempt.Quantity * attempt.UnitPrice,
            _ => unchanged && ReferenceEquals(menu, attempt.Menu) && menu!.heldItem is null && StockDigest(menu) == attempt.BeforeStock
                && menu.currentItemIndex == attempt.StartIndex + (attempt.Operation == "next_row" ? 1 : -1),
        };
        var blocked = attempt.Operation == "open" && unchanged && (Game1.activeClickableMenu is null || Game1.activeClickableMenu.GetType() == typeof(DialogueBox));
        return new { operation = attempt.Operation, completedWorkflow = confirmed, confirmedSale = attempt.Operation == "sell" && confirmed,
            blocked = !confirmed && blocked, completionUncertain = !confirmed && !blocked && attempt.Submitted,
            menuKey = menu is null ? null : Key(menu), shopId = attempt.ExpectedShop, beforeGold = attempt.Gold, afterGold = Game1.player.Money,
            beforePlayer = attempt.BeforePlayer, afterPlayer = InventoryActions.Counts(), inventoryChanges = InventoryActions.Changes(attempt.BeforePlayer),
            sourceSlot = attempt.Slot, itemId = attempt.ItemId, quality = attempt.Quality, quantitySold = attempt.Sold, unitPrice = attempt.UnitPrice,
            revision = Revision(), note = "Native handlers only. Sale/buyback/earnings side effects belong to the game; unknown partial sales are never replayed. Access conditions are not bypassed." };
    }
}
