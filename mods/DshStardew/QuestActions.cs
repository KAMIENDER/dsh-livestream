using System.Text.Json;
using System.Runtime.CompilerServices;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Quests;
using StardewValley.SpecialOrders;

namespace DshStardew;

/// <summary>Observed native boards/journal only. Never directly generate orders, grant rewards or edit quest flags.</summary>
internal static class QuestActions
{
    private static IClickableMenu? previous;
    private static string epoch = "";
    private sealed record InstanceId(string Value);
    private static readonly ConditionalWeakTable<IQuest, InstanceId> instanceIds = new();
    private static string Hash(object value) => GameFacts.Hash(JsonSerializer.Serialize(value, LocalServer.Json));
    private static bool Native(IQuest q) => q.GetType().Assembly == typeof(Quest).Assembly;
    private static SpecialOrder[] Orders() => Game1.player.team.specialOrders.ToArray();
    internal static string Key(IQuest q) => q switch {
        // Daily generated quests need not have a native ID. Bind to the actual object,
        // not a mutable list index or a guessed empty ID. Reloaded objects get new refs.
        Quest quest => $"quest:{Uri.EscapeDataString(quest.id.Value ?? "")}:{instanceIds.GetValue(quest, _ => new InstanceId(Guid.NewGuid().ToString("N"))).Value}",
        SpecialOrder order => $"order:{Uri.EscapeDataString(order.orderType.Value ?? "")}:{Uri.EscapeDataString(order.questKey.Value ?? "")}:{order.generationSeed.Value}",
        _ => "",
    };
    private static object Objective(object objective, bool contract) => new {
        type = objective.GetType().FullName,
        currentCount = contract ? null : R.Get(objective, "currentCount"),
        maximum = R.Get(objective, "maxCount"), description = R.Get(objective, "description"), failOnCompletion = R.Get(objective, "failOnCompletion"),
        details = R.Fields(objective, "acceptableContextTagSets", "acceptableItemIds", "targetName", "monsterName", "locationName", "itemId", "dropBox", "dropBoxGameLocation", "dropBoxTileLocation"),
        // Unknown objective conditions remain data, not a claim that they were interpreted or met.
    };
    private static object Reward(object reward) => new { type = reward.GetType().FullName,
        data = R.Fields(reward, "amount", "multiplier", "grantedMails", "noLetter", "host", "resetEvents", "recipes", "items") };
    private static object Contract(IQuest q) => q switch {
        Quest quest => new { key = Key(q), type = quest.GetType().FullName, questType = quest.questType.Value,
            money = quest.moneyReward.Value, details = R.Fields(quest, "target", "ItemId", "number", "monsterName", "npcName", "location", "itemFound") },
        SpecialOrder order => new { key = Key(q), type = order.GetType().FullName, dueDate = order.dueDate.Value,
            name = order.questName.Value, description = order.questDescription.Value, requester = order.requester.Value, specialRule = order.specialRule.Value,
            objectives = order.objectives.Select(o => Objective(o, true)).ToArray(), rewards = order.rewards.Select(r => Reward(r)).ToArray() },
        _ => new { unsupported = q.GetType().FullName },
    };
    private static bool Participating(SpecialOrder order) => order.participants.ContainsKey(Game1.player.UniqueMultiplayerID);
    private static int? Money(IQuest q) => q is Quest quest ? quest.moneyReward.Value
        : q is SpecialOrder order && R.Get(order, "_moneyReward") is int amount && amount >= 0 ? amount : null;
    private static bool Claimable(IQuest q) => Native(q) && Money(q) is > 0 && (q is Quest quest ? quest.completed.Value && !quest.destroy.Value
        : q is SpecialOrder order && Convert.ToInt32(order.questState.Value) == 1 && Participating(order));
    internal static string ContractDigest(IQuest q) => Hash(Contract(q));
    internal static object Fact(IQuest q) => new { key = Key(q), contractDigest = ContractDigest(q), nativeType = Native(q),
        moneyReward = Money(q), moneyClaimable = Claimable(q),
        quest = q is Quest quest ? SocialActions.QuestFact(quest) : null,
        order = q is SpecialOrder order ? new { questKey = order.questKey.Value, generationSeed = order.generationSeed.Value, orderType = order.orderType.Value,
            state = order.questState.Value.ToString(), dueDateTotalDays = order.dueDate.Value, readyForRemoval = order.readyForRemoval.Value,
            name = order.questName.Value, description = order.questDescription.Value, requester = order.requester.Value, specialRule = order.specialRule.Value,
            participating = Participating(order), participants = R.Describe(order.participants), unclaimedRewards = R.Describe(order.unclaimedRewards),
            objectives = order.objectives.Select(o => Objective(o, false)).ToArray(), rewards = order.rewards.Select(r => Reward(r)).ToArray() } : null,
    };
    internal static object State() => new { date = GameFacts.Date(), money = Game1.player.Money,
        acceptedDailyQuest = Game1.player.acceptedDailyQuest.Value,
        acceptedSpecialOrderTypes = Game1.player.team.acceptedSpecialOrderTypes.ToArray(),
        quests = Game1.player.questLog.Select(q => Fact(q)).ToArray(), orders = Orders().Select(o => Fact(o)).ToArray(),
        note = "Actual ledger and cached fields only. Unloaded money totals/text remain unknown; non-money order rewards may be handled by native updates, not this money-claim action." };
    public static object QueryOrders(JsonElement args)
    {
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 30, 1, 100);
        var key = R.Arg(args, "targetKey"); var orders = Orders().Where(o => key.Length == 0 || Key(o) == key).ToArray();
        return new { items = orders.Skip(offset).Take(limit).Select(o => Fact(o)).ToArray(), count = orders.Length, offset,
            nextOffset = offset + limit < orders.Length ? (int?)(offset + limit) : null,
            acceptedTypes = Game1.player.team.acceptedSpecialOrderTypes.ToArray(), date = GameFacts.Date(),
            note = "Raw native objectives/rewards/participants. Conditions and all order-specific flows are not interpreted; no Grant, completion, donation or registration calls." };
    }
    private static IClickableMenu? Menu() => Game1.activeClickableMenu is { } menu && menu.GetChildMenu() is null ? menu : null;
    private static string Mode(IClickableMenu? menu) => menu?.GetType() == typeof(QuestLog) ? "quest_log"
        : menu?.GetType() == typeof(Billboard) && R.Bool(menu, "dailyQuestBoard") ? "daily_board"
        : menu?.GetType() == typeof(SpecialOrdersBoard) ? "special_board" : Game1.activeClickableMenu is null ? "world" : "other";
    private static IQuest[][] Pages(QuestLog log) => R.Items(R.Get(log, "pages")).Select(page => R.Items(page).OfType<IQuest>().ToArray()).ToArray();
    private static int Page(QuestLog log) => (int)R.Number(log, "currentPage");
    private static int Selected(QuestLog log) => (int)R.Number(log, "questPage");
    private static IQuest? Shown(QuestLog log) => R.Get(log, "_shownQuest") as IQuest;
    private static object Button(ClickableComponent? button) => new { visible = button?.visible == true, bounds = R.Plain(button?.bounds) };
    public static object Capture()
    {
        var menu = Menu(); var mode = Mode(menu);
        if (!ReferenceEquals(menu, previous)) { previous = menu; epoch = Guid.NewGuid().ToString("N"); }
        object? content = null;
        if (mode == "quest_log")
        {
            var log = (QuestLog)menu!; var pages = Pages(log); var page = Page(log); var selected = Selected(log); var shown = selected >= 0 ? Shown(log) : null;
            content = new { page, pageCount = pages.Length, selectedIndex = selected, shown = shown is null ? null : Fact(shown),
                pagesTruncated = pages.Length > 64,
                pageKeys = pages.Take(64).Select(p => p.Select(Key).ToArray()).ToArray(),
                entries = page >= 0 && page < pages.Length ? pages[page].Select((q, index) => new { index, facts = Fact(q),
                    button = Button(index < log.questLogButtons.Count ? log.questLogButtons[index] : null) }).ToArray() : null,
                next = Button(log.forwardButton), previous = Button(log.backButton), reward = Button(log.rewardBox), back = Button(log.backButton) };
        }
        else if (mode == "daily_board")
        {
            var board = (Billboard)menu!; var q = Game1.questOfTheDay;
            content = new { candidate = q is null ? null : Fact(q), accept = Button(board.acceptQuestButton) };
        }
        else if (mode == "special_board")
        {
            var board = (SpecialOrdersBoard)menu!;
            content = new { boardType = board.boardType,
                left = board.leftOrder is null ? null : Fact(board.leftOrder), right = board.rightOrder is null ? null : Fact(board.rightOrder),
                acceptLeft = Button(board.acceptLeftQuestButton), acceptRight = Button(board.acceptRightQuestButton) };
        }
        var state = State(); var inventoryDigest = InventoryActions.Digest();
        var revision = Hash(new { epoch, mode, content, state, inventoryDigest, location = Game1.currentLocation.NameOrUniqueName,
            viewport = new { Game1.uiViewport.Width, Game1.uiViewport.Height }, uiScale = Game1.options.uiScale });
        return new { mode, content, revision, state, inventoryDigest, eventUp = Game1.eventUp,
            note = "Actual current native board/journal; cached text and reward total may be unloaded. A visible button does not prove acceptance/claim. No lazy description getters or quest generation in this query." };
    }
    private static void Match(JsonElement args)
    {
        InventoryActions.Require(!Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null, "Quest UI does not control events/minigames");
        InventoryActions.Require(R.Text(Capture(), "revision") == R.Arg(args, "revision"), "Quest UI/ledger/inventory changed; requery semantic revision");
    }
    private static void MatchTarget(IQuest? q, JsonElement args, bool contract = false)
    {
        InventoryActions.Require(q is not null && Native(q) && Key(q).Length > 0 && Key(q) == R.Arg(args, "targetKey"), "Select the actual unique native quest/order key");
        if (contract) InventoryActions.Require(ContractDigest(q!) == R.Arg(args, "contractDigest"), "Quest/order contract changed; review the current native offer");
    }
    private static (ClickableComponent button, IQuest? quest) Target(JsonElement args)
    {
        var operation = R.Arg(args, "operation"); var menu = Menu(); var mode = Mode(menu);
        if (mode == "daily_board" && operation == "accept_daily")
        {
            var board = (Billboard)menu!; var q = Game1.questOfTheDay; MatchTarget(q, args, true);
            InventoryActions.Require(!Game1.player.acceptedDailyQuest.Value && q is not null && !Game1.player.questLog.Contains(q) && !q.accepted.Value && !q.completed.Value && !q.destroy.Value, "Daily offer was already accepted or is unavailable");
            return (board.acceptQuestButton, q);
        }
        if (mode == "special_board" && operation == "accept_order")
        {
            var board = (SpecialOrdersBoard)menu!;
            var matches = new[] { (board.leftOrder, board.acceptLeftQuestButton), (board.rightOrder, board.acceptRightQuestButton) }
                .Where(row => row.Item1 is not null && Key(row.Item1) == R.Arg(args, "targetKey")).ToArray();
            InventoryActions.Require(matches.Length == 1, "Order key is not uniquely offered on this actual board");
            var (q, button) = matches[0]; MatchTarget(q, args, true);
            InventoryActions.Require(q!.orderType.Value == board.boardType && !Game1.player.team.acceptedSpecialOrderTypes.Contains(board.boardType)
                && !Orders().Any(o => o.questKey.Value == q.questKey.Value), "Order type/key has already been taken or does not match this board");
            return (button, q);
        }
        InventoryActions.Require(mode == "quest_log", "Open the actual relevant native board or journal first");
        var log = (QuestLog)menu!; var pages = Pages(log); var page = Page(log); var selected = Selected(log);
        InventoryActions.Require(page >= 0 && page < pages.Length, "Actual journal page is unavailable");
        if (operation is "next_page" or "previous_page")
        {
            InventoryActions.Require(selected < 0 && (operation == "next_page" ? page + 1 < pages.Length : page > 0), "No adjacent list page in this direction");
            return (operation == "next_page" ? log.forwardButton : log.backButton, null);
        }
        if (operation == "select")
        {
            InventoryActions.Require(selected < 0, "Leave the current shown quest explicitly before selecting another");
            var rows = pages[page].Select((q, index) => (q, index)).Where(row => Key(row.q) == R.Arg(args, "targetKey")).ToArray();
            InventoryActions.Require(rows.Length == 1 && rows[0].index < log.questLogButtons.Count, "Target key is not unique on this native page");
            MatchTarget(rows[0].q, args); return (log.questLogButtons[rows[0].index], rows[0].q);
        }
        var shown = Shown(log); MatchTarget(shown, args);
        InventoryActions.Require(selected >= 0 && selected < pages[page].Length && ReferenceEquals(pages[page][selected], shown), "Shown journal object no longer matches its selected page");
        if (operation == "back_to_list") return (log.backButton, shown);
        InventoryActions.Require(operation == "claim_money" && Claimable(shown!) && shown!.ShouldDisplayAsComplete() && shown.HasMoneyReward(), "This shown native quest/order has no claimable completed money reward");
        var amount = R.Int(args, "expectedReward", 0, 1, int.MaxValue);
        InventoryActions.Require(Money(shown!) == amount && shown!.GetMoneyReward() == amount && Game1.player.Money <= int.MaxValue - amount, "Reward amount changed or cannot be represented without overflow");
        return (log.rewardBox, shown);
    }
    public static Point Pointer(JsonElement args)
    {
        Match(args); var (button, _) = Target(args);
        InventoryActions.Require(button is not null && button.visible && button.bounds.Width > 0 && button.bounds.Height > 0, "Native quest UI control is not visible");
        var bounds = button.bounds;
        if (R.Arg(args, "operation") == "claim_money")
        {
            // In the inspected 1.6.15 QuestLog handler, a long title on a timed quest
            // tests y-48 against rewardBox. Use the intersection valid for both actual
            // layouts; never invoke GetName/description just to guess a layout offset.
            InventoryActions.Require(typeof(QuestLog).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317"), "Money-button layout needs an audit for this different game build");
            InventoryActions.Require(bounds.Height > 48, "Reward geometry has no safe overlap for the native title layouts");
            bounds = new Rectangle(bounds.X, bounds.Y + 48, bounds.Width, bounds.Height - 48);
        }
        var point = bounds.Center;
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(point), "Quest target is outside the actual UI viewport");
        if (R.Arg(args, "operation") == "back_to_list" && Menu() is QuestLog log)
            InventoryActions.Require(!log.cancelQuestButton.bounds.Contains(point) && !log.rewardBox.bounds.Contains(point), "Back control overlaps a different native action");
        Game1.setMousePosition(point.X, point.Y, true); return point;
    }
    public static object Open(JsonElement args)
    {
        Match(args);
        InventoryActions.Require(R.Arg(args, "operation") == "open_log" && Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool, "Open journal only from the idle world");
        var before = State(); var items = InventoryActions.Counts(); var money = Game1.player.Money;
        var day = GameFacts.DayKey(); var location = Game1.currentLocation;
        Game1.activeClickableMenu = new QuestLog();
        var confirmed = Game1.activeClickableMenu?.GetType() == typeof(QuestLog) && day == GameFacts.DayKey() && ReferenceEquals(location, Game1.currentLocation)
            && !Game1.eventUp && Game1.player.Money == money && InventoryActions.Changes(items).Length == 0;
        return new { submitted = true, operation = "open_log", confirmedEffect = confirmed, completionUncertain = !confirmed,
            beforeState = before, afterState = State(), beforeGold = money, afterGold = Game1.player.Money, inventoryChanges = InventoryActions.Changes(items), after = Capture(),
            note = "Normal native journal constructor may remove already-destroyed quests. Opening is a write, not a pure query or a reward claim." };
    }
    public static object Close(JsonElement args)
    {
        Match(args); var menu = Menu(); var mode = Mode(menu);
        InventoryActions.Require(R.Arg(args, "operation") == "close" && menu is not null && (mode is "daily_board" or "special_board" || mode == "quest_log" && Selected((QuestLog)menu) < 0)
            && menu.readyToClose(), "Close only the current known board or journal list; leave a shown quest explicitly first");
        var before = State(); var items = InventoryActions.Counts(); var money = Game1.player.Money;
        var day = GameFacts.DayKey(); var location = Game1.currentLocation;
        // Same native close handler used by the boards' right-click and normal cancel.
        menu!.exitThisMenu(true);
        var confirmed = Game1.activeClickableMenu is null && day == GameFacts.DayKey() && ReferenceEquals(location, Game1.currentLocation)
            && !Game1.eventUp && Game1.player.Money == money && InventoryActions.Changes(items).Length == 0;
        return new { submitted = true, operation = "close", confirmedEffect = confirmed, completionUncertain = !confirmed,
            beforeState = before, afterState = State(), beforeGold = money, afterGold = Game1.player.Money, inventoryChanges = InventoryActions.Changes(items), after = Capture() };
    }
    public static object Click(JsonElement args, Point point)
    {
        Match(args); var menu = Menu()!; var operation = R.Arg(args, "operation");
        var (_, q) = Target(args); var expected = Pointer(args);
        InventoryActions.Require(expected == point, "Native quest control geometry changed");
        var before = State(); var targetBefore = q is null ? null : Fact(q); var beforeMoney = Game1.player.Money;
        var beforeItems = InventoryActions.Counts(); var day = GameFacts.DayKey(); var location = Game1.currentLocation;
        var beforePage = menu is QuestLog oldLog ? Page(oldLog) : -1;
        menu.performHoverAction(point.X, point.Y); menu.receiveLeftClick(point.X, point.Y, true);
        if (ReferenceEquals(menu, Menu())) menu.releaseLeftClick(point.X, point.Y);
        var changes = InventoryActions.Changes(beforeItems);
        var sameContext = day == GameFacts.DayKey() && ReferenceEquals(location, Game1.currentLocation) && ReferenceEquals(menu, Menu()) && !Game1.eventUp;
        var noCost = changes.Length == 0 && Game1.player.Money == beforeMoney;
        var confirmed = false; IQuest? targetAfter = q;
        if (operation == "accept_daily" && q is Quest daily)
            confirmed = sameContext && noCost && Game1.player.questLog.Count(x => ReferenceEquals(x, daily)) == 1 && Game1.player.acceptedDailyQuest.Value
                && daily.accepted.Value && daily.dailyQuest.Value && daily.dayQuestAccepted.Value == Game1.Date.TotalDays && daily.daysLeft.Value == 2;
        else if (operation == "accept_order" && q is SpecialOrder offer)
        {
            var matches = Orders().Where(o => Key(o) == Key(offer)).ToArray(); targetAfter = matches.Length == 1 ? matches[0] : null;
            confirmed = sameContext && noCost && targetAfter is not null && ContractDigest(targetAfter) == R.Arg(args, "contractDigest")
                && Game1.player.team.acceptedSpecialOrderTypes.Contains(offer.orderType.Value);
        }
        else if (operation == "claim_money")
        {
            var amount = R.Int(args, "expectedReward", 0, 1, int.MaxValue);
            confirmed = sameContext && changes.Length == 0 && (long)Game1.player.Money - beforeMoney == amount
                && (q is Quest quest ? quest.completed.Value && quest.destroy.Value && quest.moneyReward.Value == 0 : q is SpecialOrder order && !Participating(order));
        }
        else if (menu is QuestLog log)
            confirmed = sameContext && noCost && (operation == "select" ? Selected(log) >= 0 && ReferenceEquals(Shown(log), q)
                : operation == "back_to_list" ? Selected(log) < 0
                : operation == "next_page" ? Selected(log) < 0 && Page(log) == beforePage + 1
                : operation == "previous_page" && Selected(log) < 0 && Page(log) == beforePage - 1);
        return new { submitted = true, operation, targetKey = q is null ? null : Key(q), confirmedEffect = confirmed, completionUncertain = !confirmed,
            beforeState = before, afterState = State(), targetBefore, targetAfter = targetAfter is null ? null : Fact(targetAfter),
            beforeGold = beforeMoney, afterGold = Game1.player.Money, inventoryChanges = changes, after = Capture(),
            note = "Only the named native UI step was confirmed. Accepting is not doing the task; claiming money does not grant or prove all special-order rewards." };
    }
}
