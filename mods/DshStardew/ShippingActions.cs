using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Input;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;
using ShippingBuilding = StardewValley.Buildings.ShippingBin;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Native pending shipments are separate from ordinary storage and
/// settled income. Main bins retrieve only the actual entire last batch.</summary>
internal static class ShippingActions
{
    private sealed class Token { public readonly string Value = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Token> Tokens = new();
    private static string Key(object value) => Tokens.GetValue(value, _ => new Token()).Value;
    private static bool Supported => typeof(Farmer).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    private static IEnumerable<ShippingBuilding> Buildings() => R.Items(R.Get(Game1.currentLocation, "buildings")).OfType<ShippingBuilding>().Where(b => b.GetType() == typeof(ShippingBuilding));
    internal sealed record Target(object Instance, int X, int Y)
    {
        public Chest? Mini => Instance as Chest;
        public string Kind => Mini is null ? "big_bin" : "mini_bin";
        public string TypeId => Mini?.QualifiedItemId ?? R.Text(Instance, "buildingType");
        public string TargetKey => Key(Instance);
        public object Position => new { locationId = Game1.currentLocation.NameOrUniqueName, x = X, y = Y };
        public Farm? Farm => Mini is null ? R.Raw(Instance, "farm") as Farm : null;
        // getShippingBin is an audited field/value read. Mini GetItemsForPlayer
        // may create a wallet backing, so queries use TryGetValue only.
        public IList<Item>? Backing => Mini is { } chest ? (Game1.player.team.useSeparateWallets.Value
            ? chest.separateWalletItems.TryGetValue(Game1.player.UniqueMultiplayerID, out var personal) ? personal as IList<Item> : null
            : chest.Items as IList<Item>) : Farm?.getShippingBin(Game1.player) as IList<Item>;
        public int Capacity => Mini is null ? Backing?.Count ?? 0 : Mini.GetActualCapacity();
    }
    private static Target? At(int x, int y)
    {
        if (Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var item) && item.GetType() == typeof(Chest)
            && item is Chest chest && chest.SpecialChestType == Chest.SpecialChestTypes.MiniShippingBin) return new Target(chest, x, y);
        foreach (var building in Buildings()) if (y == R.Number(building, "tileY") && x >= R.Number(building, "tileX") && x <= R.Number(building, "tileX") + 1) return new Target(building, x, y);
        return null;
    }
    private static Target? FromArgs(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == Game1.currentLocation.NameOrUniqueName, "Use an actual current-location shipping bin");
        var x = R.Int(p, "x", -1, 0, 10000); var y = R.Int(p, "y", -1, 0, 10000); var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(x < layer.LayerWidth && y < layer.LayerHeight, "Shipping target is outside the map"); return At(x, y);
    }
    private static bool Compatible(Target t) => t.Mini is { } chest
        ? chest.GetType() == typeof(Chest) && chest.GlobalInventoryId is null && chest.playerChest.Value && !chest.fridge.Value && !chest.giftbox.Value
            && chest.SpecialChestType == Chest.SpecialChestTypes.MiniShippingBin && t.Capacity is > 0 and <= 128 && (t.Backing?.Count ?? 0) <= t.Capacity
        : t.Instance.GetType() == typeof(ShippingBuilding) && t.Farm is not null && ReferenceEquals(t.Farm, Game1.getFarm())
            && R.Number(t.Instance, "daysOfConstructionLeft") == 0 && t.Backing is not null && t.Capacity <= 16384;
    private static bool Clear(Target t) => (t.Mini is not null || !Game1.currentLocation.Objects.ContainsKey(new Vector2(t.X, t.Y)))
        && !Game1.currentLocation.characters.Any(a => a.GetBoundingBox().Intersects(new Rectangle(t.X * 64, t.Y * 64, 64, 64)))
        && !AnimalCare.In(Game1.currentLocation).Any(a => a.GetBoundingBox().Intersects(new Rectangle(t.X * 64, t.Y * 64, 64, 64)));
    private static bool Plain(Item? item) => item?.GetType() == typeof(SObject) && item is SObject obj && !obj.IsRecipe && !obj.isLostItem && !obj.specialItem && !obj.Special
        && obj.QualifiedItemId is not "(O)326" and not "(O)102" and not "(O)434" and not "(O)858" && obj.canBeShipped();
    private static InventoryActions.Count[] Counts(IList<Item>? inventory) => (inventory ?? Array.Empty<Item>()).Where(item => item is not null)
        .GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(g => new InventoryActions.Count(g.Key.QualifiedItemId, g.Key.Quality, g.Sum(item => (long)item.Stack)))
        .OrderBy(row => row.ItemId, StringComparer.Ordinal).ThenBy(row => row.Quality).ToArray();
    private static object? ItemFact(Item? item) => item is null ? null : new { itemKey = Key(item), qualifiedItemId = item.QualifiedItemId, quality = item.Quality,
        stack = item.Stack, eligible = Plain(item), type = item.GetType().FullName };
    private static string TargetDigest(Target t) => GameFacts.Hash(JsonSerializer.Serialize(new { t.TargetKey, t.Position, t.Kind, t.TypeId,
        type = t.Instance.GetType().FullName, capacity = t.Mini?.GetActualCapacity(), farm = t.Farm is { } farm ? Key(farm) : null,
        construction = t.Mini is null ? R.Get(t.Instance, "daysOfConstructionLeft") : null, separateWallet = Game1.player.team.useSeparateWallets.Value,
    }, LocalServer.Json));
    private static object Capture(Target t)
    {
        var backing = t.Backing; var capacity = t.Capacity;
        InventoryActions.Require(capacity is >= 0 and <= 16384 && (backing?.Count ?? 0) <= capacity, "Shipping backing exceeds complete capture bounds");
        var rows = Enumerable.Range(0, capacity).Select(index => new { index, item = ItemFact(backing is not null && index < backing.Count ? backing[index] : null) }).ToArray();
        var last = t.Farm?.lastItemShipped; var lastRows = backing is null || last is null ? Array.Empty<int>() : Enumerable.Range(0, backing.Count).Where(i => ReferenceEquals(backing[i], last)).ToArray();
        return new { backingExists = backing is not null, backingKey = backing is null ? null : Key(backing), slotCount = capacity, slots = rows,
            counts = backing is null ? null : Counts(backing), last = ItemFact(last), lastSlot = lastRows.Length == 1 ? (int?)lastRows[0] : null,
            digest = GameFacts.Hash(JsonSerializer.Serialize(new { backing = backing is null ? null : Key(backing), capacity, rows, last = ItemFact(last), lastRows }, LocalServer.Json)),
            note = "Native pending inventory, not MCP containerRef/revision or settled income. A missing mini-wallet backing is not materialized by this query." };
    }
    private static bool Handler(object? value, object? owner, Type type, string name) => value is Delegate d && d.GetInvocationList().Length == 1
        && ReferenceEquals(d.Target, owner) && d.Method.DeclaringType == type && d.Method.Name == name;
    private static ItemGrabMenu? Current(Target t)
    {
        if (Game1.activeClickableMenu?.GetType() != typeof(ItemGrabMenu) || Game1.activeClickableMenu.GetChildMenu() is not null || !Compatible(t)) return null;
        var menu = (ItemGrabMenu)Game1.activeClickableMenu;
        if (!ReferenceEquals(menu.context, t.Instance) || R.Raw(menu, "essential") is not false || R.Raw(menu, "superEssential") is not false
            || menu.inventory.GetType() != typeof(InventoryMenu) || !ReferenceEquals(menu.inventory.actualInventory, Game1.player.Items)
            || menu.inventory.inventory.Count > 256 || !Handler(R.Raw(menu.inventory, "highlightMethod"), null, typeof(Utility), "highlightShippableObjects")) return null;
        if (t.Mini is { } chest) return !menu.shippingBin && menu.source == ItemGrabMenu.source_chest && ReferenceEquals(menu.sourceItem, chest)
            && !menu.reverseGrab && menu.showReceivingMenu && !menu.destroyItemOnClick && menu.allowRightClick && t.Backing is { } backing
            && ReferenceEquals(menu.ItemsToGrabMenu.actualInventory, backing) && menu.ItemsToGrabMenu.GetType() == typeof(InventoryMenu)
            && Handler(R.Raw(menu.ItemsToGrabMenu, "highlightMethod"), null, typeof(Utility), "highlightShippableObjects")
            && Handler(menu.behaviorFunction, chest, typeof(Chest), "grabItemFromInventory") && Handler(menu.behaviorOnItemGrab, chest, typeof(Chest), "grabItemFromChest")
            && chest.GetMutex().IsLockHeld() ? menu : null;
        return menu.shippingBin && menu.reverseGrab && menu.destroyItemOnClick && menu.allowRightClick && !menu.showReceivingMenu && menu.sourceItem is null
            && Handler(menu.behaviorFunction, t.Instance, typeof(ShippingBuilding), "shipItem") && menu.behaviorOnItemGrab is null ? menu : null;
    }
    private static object TargetFact(Target t) => new { t.TargetKey, t.Position, kind = t.Kind, typeId = t.TypeId, targetDigest = TargetDigest(t), compatible = Compatible(t),
        adjacent = Math.Abs(Game1.player.Tile.X - t.X) + Math.Abs(Game1.player.Tile.Y - t.Y) == 1, clear = Clear(t),
        lockHeld = t.Mini is { } chest ? (bool?)chest.GetMutex().IsLockHeld() : null, pending = Compatible(t) ? Capture(t) : null };
    private static string Revision(Target t) => GameFacts.Hash(JsonSerializer.Serialize(new { target = TargetFact(t), save = GameFacts.SaveId(), day = GameFacts.DayKey(),
        location = Game1.currentLocation.NameOrUniqueName, tile = R.Plain(Game1.player.Tile), inventory = InventoryActions.Digest(), gold = Game1.player.Money,
        menu = Game1.activeClickableMenu is { } root ? Key(root) : null, current = Current(t) is { } menu ? new {
            held = ItemFact(menu.heldItem), playerBounds = menu.inventory.inventory.Select(c => new { c.name, c.visible, bounds = R.Plain(c.bounds) }).ToArray(),
            targetBounds = t.Mini is null ? null : menu.ItemsToGrabMenu.inventory.Select(c => new { c.name, c.visible, bounds = R.Plain(c.bounds) }).ToArray(), lastHolder = R.Plain(menu.lastShippedHolder?.bounds),
        } : null, viewport = new { Game1.uiViewport.Width, Game1.uiViewport.Height },
    }, LocalServer.Json));
    public static object Query(JsonElement args)
    {
        var selected = args.TryGetProperty("position", out _) ? FromArgs(args) : null; var targets = new List<Target>();
        if (selected is not null) targets.Add(selected);
        else if (!args.TryGetProperty("position", out _)) {
            foreach (var pair in Game1.currentLocation.Objects.Pairs) if (pair.Value.GetType() == typeof(Chest) && pair.Value is Chest chest && chest.SpecialChestType == Chest.SpecialChestTypes.MiniShippingBin) targets.Add(new Target(chest, (int)pair.Key.X, (int)pair.Key.Y));
            foreach (var b in Buildings()) targets.Add(new Target(b, (int)R.Number(b, "tileX"), (int)R.Number(b, "tileY")));
            targets = targets.Where(t => Math.Abs(Game1.player.Tile.X - t.X) + Math.Abs(Game1.player.Tile.Y - t.Y) <= 12).ToList();
        }
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 20, 1, 100); var current = selected is null ? null : Current(selected);
        return new { supportedBuild = Supported, revision = selected is null ? null : Revision(selected), items = targets.Skip(offset).Take(limit).Select(TargetFact).ToArray(),
            count = targets.Count, offset, nextOffset = offset + limit < targets.Count ? (int?)(offset + limit) : null, player = InventoryActions.Counts(), gold = Game1.player.Money,
            playerSlots = Game1.player.Items.Select((item, index) => new { index, item = ItemFact(item) }).ToArray(),
            menuType = Game1.activeClickableMenu?.GetType().FullName, current = current is null ? null : new { menuKey = Key(current), targetKey = selected!.TargetKey,
                held = ItemFact(current.heldItem), pendingBackingKey = selected.Backing is { } backing ? Key(backing) : null }, queuedOnlyNotSettled = true };
    }
    internal sealed class Attempt
    {
        public Target Target = null!; public ItemGrabMenu? Menu; public WorldInteraction? World; public IList<Item>? Backing; public Item? Source;
        public string Operation = "", Revision = "", ItemId = ""; public int Slot = -1, Quantity, Quality, Done, StartStack, Gold, InteractionSlot = -1;
        public bool Submitted, WholeStack, BackingExisted; public Point Pointer;
        public InventoryActions.Count[] BeforePlayer = Array.Empty<InventoryActions.Count>(), BeforePending = Array.Empty<InventoryActions.Count>();
    }
    private static Point ClickPoint(ItemGrabMenu menu, InventoryMenu? side, int slot, bool last)
    {
        var c = last ? menu.lastShippedHolder : side is not null && slot >= 0 && slot < side.inventory.Count ? side.inventory[slot] : null;
        InventoryActions.Require(c is not null && c.visible, "No actual visible shipping control"); var p = c!.bounds.Center;
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(p), "Shipping control is off screen");
        if (!last) InventoryActions.Require(c.name == slot.ToString(System.Globalization.CultureInfo.InvariantCulture), "Source is not the real UI slot");
        foreach (var field in new[] { "upperRightCloseButton", "okButton", "trashCan", "organizeButton", "fillStacksButton", "junimoNoteIcon", "specialButton", "colorPickerToggleButton" })
            InventoryActions.Require(R.Raw(menu, field) is not ClickableComponent button || !button.containsPoint(p.X, p.Y), "Source overlaps another native action");
        if (last) InventoryActions.Require(!menu.inventory.inventory.Any(button => button.containsPoint(p.X, p.Y)), "Last holder overlaps backpack");
        else {
            var other = ReferenceEquals(side, menu.inventory) ? menu.showReceivingMenu ? menu.ItemsToGrabMenu : null : menu.inventory;
            InventoryActions.Require(other is null || !other.inventory.Any(button => button.containsPoint(p.X, p.Y)), "Shipping inventories overlap");
            InventoryActions.Require(menu.lastShippedHolder is null || !menu.lastShippedHolder.containsPoint(p.X, p.Y), "Source overlaps last retrieval");
        }
        return p;
    }
    private static bool Delta(InventoryActions.Count[] before, InventoryActions.Count[] after, string id, int quality, long change)
    {
        var left = before.ToDictionary(r => (r.ItemId, r.Quality), r => r.Amount); var right = after.ToDictionary(r => (r.ItemId, r.Quality), r => r.Amount);
        if (change != 0) left[(id, quality)] = left.GetValueOrDefault((id, quality)) + change;
        return left.Keys.Concat(right.Keys).Distinct().All(key => left.GetValueOrDefault(key) == right.GetValueOrDefault(key));
    }
    private static bool CanAccept(IList<Item> inventory, int capacity, Item source, int quantity)
    {
        var maximum = source.maximumStackSize(); if (maximum <= 0 || inventory.Count > capacity) return false;
        long room = Math.Max(0, capacity - inventory.Count) * (long)maximum;
        foreach (var item in inventory) room += item is null ? maximum : item.canStackWith(source) ? Math.Max(0, item.maximumStackSize() - item.Stack) : 0;
        return room >= quantity;
    }
    internal static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(Supported && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null && Game1.player.health > 0, "Shipping context/build unavailable"); var t = FromArgs(args);
        InventoryActions.Require(t is not null && Compatible(t) && t.TargetKey == R.Arg(args, "targetKey") && TargetDigest(t) == R.Arg(args, "targetDigest"), "Exact shipping target changed");
        InventoryActions.Require(Revision(t!) == R.Arg(args, "revision"), "Shipping/player/menu changed");
        var a = new Attempt { Target = t!, Operation = R.Arg(args, "operation"), Revision = Revision(t!), Menu = Current(t!), Gold = Game1.player.Money,
            BeforePlayer = InventoryActions.Counts(), BeforePending = Counts(t!.Backing), BackingExisted = t.Backing is not null, Backing = t.Backing };
        if (a.Operation == "open") {
            InventoryActions.Require(Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool && Clear(t)
                && Math.Abs(Game1.player.Tile.X - t.X) + Math.Abs(Game1.player.Tile.Y - t.Y) == 1, "Stand adjacent to unobstructed shipping target");
            a.InteractionSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(i => Game1.player.Items[i] is null || Game1.player.Items[i] is Tool, -1);
            InventoryActions.Require(a.InteractionSlot >= 0, "Need actual empty/tool slot for access"); return a;
        }
        var menu = a.Menu; InventoryActions.Require(menu is not null && Key(menu) == R.Arg(args, "menuKey") && menu.heldItem is null && a.Backing is not null, "No exact empty-cursor shipping menu/backing");
        if (a.Operation == "close") { InventoryActions.Require(menu!.readyToClose(), "Shipping UI is not ready to close"); return a; }
        a.Quantity = R.Int(args, "quantity", 0, 1, 10000); a.Quality = R.Int(args, "expectedQuality", -1, 0, 4); a.ItemId = R.Arg(args, "expectedItemId");
        if (a.Operation == "retrieve_last") {
            InventoryActions.Require(t.Mini is null, "Only main bins have last-batch retrieval"); a.Source = t.Farm!.lastItemShipped;
            InventoryActions.Require(a.Source is not null && a.Backing!.Count(item => ReferenceEquals(item, a.Source)) == 1 && a.Source.Stack == a.Quantity, "Only the entire actual last batch can be retrieved");
            a.Pointer = ClickPoint(menu!, null, -1, true); a.WholeStack = true;
        } else {
            InventoryActions.Require(a.Operation == "deposit" || a.Operation == "withdraw" && t.Mini is not null, "Unknown movement or arbitrary main-bin withdrawal");
            var playerSource = a.Operation == "deposit"; var source = playerSource ? Game1.player.Items as IList<Item> : a.Backing;
            a.Slot = R.Int(args, "sourceSlot", -1, 0, source!.Count - 1); a.Source = source[a.Slot];
            InventoryActions.Require(a.Source is not null && a.Source.Stack >= a.Quantity, "Shipping source quantity insufficient"); a.WholeStack = a.Source!.Stack == a.Quantity;
            InventoryActions.Require(a.WholeStack || a.Quantity <= 999, "Partial native movement is bounded to 999 units"); a.Pointer = ClickPoint(menu!, playerSource ? menu!.inventory : menu!.ItemsToGrabMenu, a.Slot, false);
        }
        InventoryActions.Require(Plain(a.Source) && a.Source!.QualifiedItemId == a.ItemId && a.Source.Quality == a.Quality && Key(a.Source) == R.Arg(args, "itemKey"), "Exact ordinary shippable source changed or special receipt needs another adapter"); a.StartStack = a.Source!.Stack;
        if (a.Operation != "deposit") {
            Game1.player.GetItemReceiveBehavior(a.Source, out var needsSpace, out _);
            InventoryActions.Require(needsSpace && CanAccept(Game1.player.Items, Game1.player.MaxItems, a.Source, a.Quantity), "Player cannot receive approved quantity without automatic conversion");
        } else {
            // Partial main deposits append one-item batches. They do not create
            // one large last batch; pre-split in the world if that is required.
            var added = t.Mini is null ? a.WholeStack ? 1 : a.Quantity : 0;
            InventoryActions.Require(t.Capacity + added <= 16384, "Shipping list would exceed complete capture bounds");
            if (t.Mini is { } mini) InventoryActions.Require(CanAccept(a.Backing!, mini.GetActualCapacity(), a.Source, a.Quantity), "Mini bin cannot accept the whole approved quantity");
        }
        InventoryActions.Require(a.WholeStack || !Game1.oldKBState.IsKeyDown(Keys.LeftShift), "Release native left Shift before exact partial shipping"); return a;
    }
    internal static bool ContextMatches(Attempt a) => ReferenceEquals(At(a.Target.X, a.Target.Y)?.Instance, a.Target.Instance) && Compatible(a.Target) && Revision(a.Target) == a.Revision;
    internal static void Execute(Attempt a)
    {
        InventoryActions.Require(ContextMatches(a), "Shipping changed before native action"); a.Submitted = true;
        if (a.Operation == "open") { a.World = WorldInteraction.Begin(a.Target.X, a.Target.Y, a.InteractionSlot); a.Revision = Revision(a.Target); return; }
        if (a.Operation == "close") { a.Menu!.exitThisMenu(); return; }
        var menu = Current(a.Target); InventoryActions.Require(ReferenceEquals(menu, a.Menu) && menu!.heldItem is null && (a.WholeStack || !Game1.oldKBState.IsKeyDown(Keys.LeftShift)), "Shipping menu/cursor/modifier changed");
        var step = a.WholeStack ? a.Quantity : 1;
        if (a.Operation == "retrieve_last") InventoryActions.Require(ReferenceEquals(a.Target.Farm!.lastItemShipped, a.Source), "Last batch changed");
        else {
            var source = a.Operation == "deposit" ? Game1.player.Items as IList<Item> : a.Target.Backing;
            InventoryActions.Require(a.Slot < source!.Count && ReferenceEquals(source[a.Slot], a.Source) && source[a.Slot].Stack == a.StartStack - a.Done, "Actual source slot changed");
            a.Pointer = ClickPoint(menu!, a.Operation == "deposit" ? menu!.inventory : menu!.ItemsToGrabMenu, a.Slot, false);
        }
        if (a.WholeStack) menu!.receiveLeftClick(a.Pointer.X, a.Pointer.Y, false); else menu!.receiveRightClick(a.Pointer.X, a.Pointer.Y, false);
        a.Done += step; var fresh = Current(a.Target); var sign = a.Operation == "deposit" ? -1 : 1;
        InventoryActions.Require(fresh is not null && fresh.heldItem is null && ReferenceEquals(a.Target.Backing, a.Backing) && Game1.player.Money == a.Gold
            && Delta(a.BeforePlayer, InventoryActions.Counts(), a.ItemId, a.Quality, sign * a.Done) && Delta(a.BeforePending, Counts(a.Target.Backing), a.ItemId, a.Quality, -sign * a.Done), "Shipping did not conserve both sides");
        if (a.Target.Mini is null) InventoryActions.Require(a.Operation == "retrieve_last" ? a.Target.Farm!.lastItemShipped is null
            : a.Target.Farm!.lastItemShipped is { } last && last.QualifiedItemId == a.ItemId && last.Quality == a.Quality && last.Stack == step
                && a.Target.Backing!.Count(item => ReferenceEquals(item, last)) == 1, "Native last batch did not match");
        // Chest.clearNulls compacts mini slots after its own native callback.
        // Follow the exact remaining source instance, never another matching stack.
        if (a.Operation == "withdraw" && a.Done < a.Quantity) {
            var remaining = Enumerable.Range(0, a.Target.Backing!.Count).Where(i => ReferenceEquals(a.Target.Backing[i], a.Source)).ToArray();
            InventoryActions.Require(remaining.Length == 1, "Remaining source identity changed after native compaction"); a.Slot = remaining[0];
        }
        a.Menu = fresh; a.Revision = Revision(a.Target);
    }
    internal static object Finish(Attempt a)
    {
        var current = Current(a.Target); var attached = ReferenceEquals(At(a.Target.X, a.Target.Y)?.Instance, a.Target.Instance);
        var player = InventoryActions.Counts(); var pending = Counts(a.Target.Backing); var goldSame = Game1.player.Money == a.Gold;
        var unchanged = Delta(a.BeforePlayer, player, "", 0, 0) && Delta(a.BeforePending, pending, "", 0, 0) && goldSame;
        var confirmed = attached && (a.Operation == "close" ? unchanged && Game1.activeClickableMenu is null && (a.Target.Mini is null || !a.Target.Mini.GetMutex().IsLockHeld()) : a.Operation == "open" ? unchanged && current is not null && current.heldItem is null
            && (!a.BackingExisted || ReferenceEquals(a.Target.Backing, a.Backing)) : a.Done == a.Quantity && current is not null && current.heldItem is null && goldSame
            && Delta(a.BeforePlayer, player, a.ItemId, a.Quality, (a.Operation == "deposit" ? -1 : 1) * a.Quantity)
            && Delta(a.BeforePending, pending, a.ItemId, a.Quality, (a.Operation == "deposit" ? 1 : -1) * a.Quantity));
        return new { operation = a.Operation, completedWorkflow = confirmed, completionUncertain = !confirmed && a.Submitted, targetKey = a.Target.TargetKey, kind = a.Target.Kind,
            menuKey = current is null ? null : Key(current), itemId = a.ItemId, quality = a.Quality, quantity = a.Done, sourceSlotAfter = a.Slot, beforeGold = a.Gold, afterGold = Game1.player.Money,
            beforePlayer = a.BeforePlayer, afterPlayer = player, beforePending = a.BeforePending, afterPending = pending, inventoryChanges = InventoryActions.Changes(a.BeforePlayer),
            pending = Capture(a.Target), createdBacking = !a.BackingExisted && a.Target.Backing is not null, queuedOnlyNotSettled = true,
            note = "Native pending movements only, no income/stats credit. Main retrieval is the entire last batch. Partial main deposits create one-item batches; native mini menu replacement/compaction is accepted only after conserving verified actions." };
    }
}
