using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Quests;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Native social interaction, ordinary gift receipts and exact ItemDeliveryQuest hand-in.</summary>
internal static class SocialActions
{
    private static DialogueBox? previousBox;
    private static string dialogueEpoch = "";
    private static DialogueBox? boundBox;
    private static string boundNpc = "", boundSave = "", boundDay = "";
    private static NPC Find(string name)
    {
        InventoryActions.Require(name.Length is > 0 and <= 128 && !name.Any(char.IsControl), "Use an actual internal NPC name");
        var matches = Game1.currentLocation.characters.Where(npc => npc.Name == name).ToArray();
        InventoryActions.Require(matches.Length == 1, "NPC is not uniquely present in the current location");
        return matches[0];
    }
    private static Friendship? Friend(string name) => Game1.player.friendshipData.TryGetValue(name, out var value) ? value : null;
    private static Friendship? Friend(NPC npc) => Friend(npc.Name);
    private static object? FriendshipFact(NPC npc)
        => FriendshipFact(npc.Name);
    private static object? FriendshipFact(string name)
    {
        var f = Friend(name);
        return f is null ? null : new { f.Points, f.GiftsToday, f.GiftsThisWeek, f.TalkedToToday, status = f.Status.ToString(),
            isMarried = f.IsMarried(), isDivorced = f.IsDivorced(), isRoommate = f.IsRoommate(),
            lastGiftDate = R.Fields(f.LastGiftDate, "Year", "Season", "DayOfMonth", "TotalDays") };
    }
    internal static object QuestFact(Quest q) => new {
        id = q.id.Value, key = QuestActions.Key(q), type = q.GetType().FullName, accepted = q.accepted.Value, completed = q.completed.Value, destroyed = q.destroy.Value,
        daily = q.dailyQuest.Value, daysLeft = q.daysLeft.Value, moneyRewardField = q.moneyReward.Value,
        loadedTitle = R.Get(q, "_questTitle"), loadedDescription = R.Get(q, "_questDescription"), loadedObjective = R.Get(q, "_currentObjective"),
        delivery = q is ItemDeliveryQuest d ? new { npcName = d.target.Value, itemId = d.ItemId.Value, count = d.number.Value } : null,
        details = R.Fields(q, "target", "ItemId", "number", "numberCollected", "numberFished", "numberKilled", "monsterName", "npcName", "location", "itemFound"),
    };
    internal static object[] QuestFacts() => Game1.player.questLog.Select(QuestFact).ToArray();
    public static object Quests(JsonElement args)
    {
        var id = R.Arg(args, "questId"); var key = R.Arg(args, "targetKey"); var state = R.Arg(args, "state", "all");
        InventoryActions.Require(state is "all" or "active" or "completed", "Unknown quest state filter");
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 30, 1, 100);
        var quests = Game1.player.questLog.Where(q => (id.Length == 0 || q.id.Value == id) && (key.Length == 0 || QuestActions.Key(q) == key)
            && (state == "all" || state == "active" && !q.completed.Value && !q.destroy.Value || state == "completed" && q.completed.Value)).ToArray();
        return new { items = quests.Skip(offset).Take(limit).Select(QuestFact).ToArray(), count = quests.Length, offset,
            nextOffset = offset + limit < quests.Length ? (int?)(offset + limit) : null,
            note = "Actual player quest log; cached display text can be unloaded. No quest generation, completion, reward claims or description RNG. ItemDeliveryQuest has a typed hand-in contract; other quest types remain raw facts." };
    }
    private static string ActorDigest(NPC npc) => GameFacts.Hash(JsonSerializer.Serialize(new {
        npc.Name, location = Game1.currentLocation.NameOrUniqueName, npc.Tile, sleeping = npc.isSleeping.Value, invisible = npc.IsInvisible,
        birthday = npc.isBirthday(), friendship = FriendshipFact(npc), quests = QuestFacts(), date = GameFacts.DayKey(),
    }, LocalServer.Json));
    private static bool UniversalSpecial(SObject item) => item.QualifiedItemId is "(O)809" or "(O)458" or "(O)277" or "(O)460" or "(O)StardropTea";
    private static bool SpecialFor(NPC npc, SObject item) => UniversalSpecial(item)
        || npc.Name == "Pierre" && item.QualifiedItemId == "(O)897"
        || npc.Name == "Lewis" && item.QualifiedItemId == "(O)71"
        || npc.Name == "Jas" && Game1.currentLocation.NameOrUniqueName == "DesertFestival" && item.QualifiedItemId == "(O)233"
        || Game1.player.questLog.Any(q => q.id.Value == "130" && !q.completed.Value && !q.destroy.Value)
            && new[] { "(O)867", "(O)864", "(O)865", "(O)866", "(O)868", "(O)869", "(O)870" }.Contains(item.QualifiedItemId);
    private static bool Ordinary(NPC npc, SObject item) => item.GetType() == typeof(SObject) && item.Stack > 0 && !item.questItem.Value
        && !item.IsRecipe && item.canBeGivenAsGift() && !SpecialFor(npc, item);
    public static object Query(JsonElement args)
    {
        if (args.TryGetProperty("stateOnly", out var stateOnly) && stateOnly.GetBoolean())
        {
            var name = R.Arg(args, "npcName");
            InventoryActions.Require(name.Length is > 0 and <= 128 && !name.Any(char.IsControl), "Use an actual internal NPC name");
            return new { npcName = name, stateOnly = true, friendship = FriendshipFact(name), quests = QuestFacts(), money = Game1.player.Money, date = GameFacts.Date(),
                note = "Actual player ledger for this name; no NPC instance is created or assumed loaded." };
        }
        var npc = Find(R.Arg(args, "npcName"));
        return new { npcName = npc.Name, displayName = npc.displayName, locationId = Game1.currentLocation.NameOrUniqueName,
            position = new { locationId = Game1.currentLocation.NameOrUniqueName, x = (int)npc.Tile.X, y = (int)npc.Tile.Y },
            digest = ActorDigest(npc), inventoryDigest = InventoryActions.Digest(), villager = npc.IsVillager, canTalk = npc.canTalk(),
            canReceiveGifts = npc.CanReceiveGifts(), sleeping = npc.isSleeping.Value, invisible = npc.IsInvisible, birthday = npc.isBirthday(),
            friendship = FriendshipFact(npc),
            giftCandidates = Game1.player.Items.Select((item, index) => (item, index)).Where(row => row.item is SObject obj && Ordinary(npc, obj)).Select(row => new {
                inventorySlot = row.index, itemId = row.item.QualifiedItemId, quality = row.item.Quality, count = row.item.Stack,
                nativeTasteCode = npc.getGiftTasteForThisItem(row.item),
            }).ToArray(),
            note = "Current loaded NPC only. Candidates are ordinary gift objects, not a promise of acceptance; actual quest/order probes and gift limits are checked during the action. Chat say/emote is not NPC conversation." };
    }
    private static bool DeliveryWouldHandle(NPC npc, SObject offer)
    {
        foreach (var q in Game1.player.questLog)
        {
            if (q.completed.Value || q.destroy.Value) continue;
            if (q is ItemDeliveryQuest d && d.target.Value == npc.Name && d.ItemId.Value == offer.QualifiedItemId) return true;
            if (q.OnItemOfferedToNpc(npc, offer, true)) return true;
        }
        // This is the same native probe contract as NPC.tryToReceiveActiveObject. Do not
        // call Farmer.NotifyQuests in a read: it also removes destroyed quest records.
        foreach (var order in R.Items(R.Get(R.Get(Game1.player, "team"), "specialOrders")))
            if (R.Get(order, "onItemDelivered") is Delegate delivered)
                foreach (var handler in delivered.GetInvocationList())
                {
                    InventoryActions.Require(handler is Func<Farmer, NPC, Item, bool, int>, "Special-order delivery probe signature is not supported");
                    if (((Func<Farmer, NPC, Item, bool, int>)handler)(Game1.player, npc, offer, true) > 0) return true;
                }
        return false;
    }
    public static object Act(JsonElement args)
    {
        InventoryActions.Require(Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null && !Game1.player.UsingTool, "Close menus and finish native actions before social interaction");
        var npc = Find(R.Arg(args, "npcName")); var operation = R.Arg(args, "operation");
        InventoryActions.Require(operation is "talk" or "gift" or "deliver", "Unknown social operation");
        InventoryActions.Require(!npc.IsInvisible && !npc.isSleeping.Value && npc.canTalk(), "Social interaction requires an awake, visible talking NPC");
        InventoryActions.Require(operation == "talk" || npc.IsVillager, "Ordinary gifts and ItemDeliveryQuest require a native villager");
        InventoryActions.Require(Math.Abs((int)npc.Tile.X - (int)Game1.player.Tile.X) + Math.Abs((int)npc.Tile.Y - (int)Game1.player.Tile.Y) <= 1, "Approach adjacent to the actual NPC and requery its position");
        InventoryActions.Require(R.Arg(args, "actorDigest") == ActorDigest(npc) && R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "NPC/friendship/quest/inventory state changed; requery");
        var friend = Friend(npc); var beforeFriend = FriendshipFact(npc); var beforeQuests = QuestFacts(); var beforeItems = InventoryActions.Counts();
        var today = friend?.GiftsToday ?? 0; var week = friend?.GiftsThisWeek ?? 0; var beforeGold = Game1.player.Money;
        var location = Game1.currentLocation; var day = GameFacts.DayKey();
        SObject? offer = null; ItemDeliveryQuest? delivery = null; var required = 0; var selected = -1;
        if (operation == "talk")
        {
            selected = Enumerable.Range(0, Game1.player.Items.Count).Where(index => Game1.player.Items[index] is null or Tool).DefaultIfEmpty(-1).First();
            InventoryActions.Require(selected >= 0, "Use a real empty/tool slot so talk cannot hand over a held object");
        }
        else
        {
            selected = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1);
            offer = Game1.player.Items[selected] as SObject;
            InventoryActions.Require(offer is not null && offer.QualifiedItemId == R.Arg(args, "expectedItemId") && offer.Quality == R.Int(args, "expectedQuality", -1, 0, 4)
                && offer.Stack > 0 && offer.Stack <= R.Int(args, "maxOfferCount", 0, 1, 10000), "Use a bounded actual offer stack; split excess before offering");
            if (operation == "gift")
            {
                InventoryActions.Require(offer!.Stack == 1 && Ordinary(npc, offer) && npc.CanReceiveGifts() && friend is not null && !friend.IsDivorced(), "Use an ordinary single gift after meeting this NPC; special items have separate semantics");
                InventoryActions.Require(today == 0 && (week < 2 || npc.isBirthday() || R.Text(Game1.player, "spouse") == npc.Name), "Native daily/weekly gift limit does not permit this ordinary gift");
                var beforeProbe = GameFacts.Hash(JsonSerializer.Serialize(new { control = GameFacts.ControlState(), items = InventoryActions.Capture(), friendship = FriendshipFact(npc), quests = QuestFacts(), money = Game1.player.Money }, LocalServer.Json));
                var questOffer = DeliveryWouldHandle(npc, offer);
                if (beforeProbe != GameFacts.Hash(JsonSerializer.Serialize(new { control = GameFacts.ControlState(), items = InventoryActions.Capture(), friendship = FriendshipFact(npc), quests = QuestFacts(), money = Game1.player.Money }, LocalServer.Json))) throw new InvalidOperationException("Native quest/order probe changed observable state");
                InventoryActions.Require(!questOffer, "A quest/order handles this offer. Ordinary ItemDeliveryQuest uses npc_deliver; other delivery types need their own workflow, not a gift label");
                required = 1;
            }
            else
            {
                var id = R.Arg(args, "questId"); var key = R.Arg(args, "targetKey");
                InventoryActions.Require((key.Length is > 0 and <= 1024 && id.Length == 0 || id.Length is > 0 and <= 128 && key.Length == 0)
                    && !id.Any(char.IsControl) && !key.Any(char.IsControl), "Use one actual task instance key, or one unique nonempty native ID");
                var matches = Game1.player.questLog.Where(q => key.Length > 0 ? QuestActions.Key(q) == key : q.id.Value == id).ToArray();
                InventoryActions.Require(matches.Length == 1 && matches[0].GetType() == typeof(ItemDeliveryQuest), "Select one actual ordinary ItemDeliveryQuest");
                delivery = (ItemDeliveryQuest)matches[0]; required = delivery.number.Value;
                InventoryActions.Require(!delivery.completed.Value && !delivery.destroy.Value && delivery.target.Value == npc.Name && delivery.ItemId.Value == offer!.QualifiedItemId
                    && required > 0 && required <= offer.Stack && required <= R.Int(args, "maxOfferCount", 0, 1, 10000), "Quest target/item/amount or current state does not permit hand-in");
            }
        }
        Game1.player.CurrentToolIndex = selected;
        if (operation == "talk" ? Game1.player.ActiveObject is not null : !ReferenceEquals(Game1.player.ActiveObject, offer)) throw new InvalidOperationException("Native selected item was not confirmed");
        var delta = npc.Tile - Game1.player.Tile;
        if (delta != Vector2.Zero) Game1.player.faceDirection(Math.Abs(delta.X) > Math.Abs(delta.Y) ? delta.X > 0 ? 1 : 3 : delta.Y > 0 ? 2 : 0);
        // The exact quest handler performs its own item check, consumption, dialogue and
        // completion. Never call questComplete, receiveGift, or friendship setters directly.
        var acted = operation == "deliver" ? delivery!.OnItemOfferedToNpc(npc, offer!, false)
            : operation == "gift" ? npc.tryToReceiveActiveObject(Game1.player, false) : npc.checkAction(Game1.player, location);
        if (Game1.activeClickableMenu is DialogueBox created) { boundBox = created; boundNpc = npc.Name; boundSave = GameFacts.SaveId(); boundDay = day; }
        var changes = InventoryActions.Changes(beforeItems); var afterFriend = Friend(npc);
        var spent = changes.Where(change => change.Amount < 0).ToArray();
        var resourceConfirmed = operation == "talk" ? spent.Length == 0 : spent.Length == 1 && spent[0].ItemId == R.Arg(args, "expectedItemId")
            && spent[0].Quality == R.Int(args, "expectedQuality", -1, 0, 4) && spent[0].Amount == -required;
        var sameContext = ReferenceEquals(location, Game1.currentLocation) && day == GameFacts.DayKey() && Game1.player.Money >= beforeGold;
        var confirmed = sameContext && resourceConfirmed && (operation == "talk" ? acted || Game1.activeClickableMenu is DialogueBox || Game1.eventUp
            : operation == "gift" ? acted && afterFriend?.GiftsToday == today + 1 && afterFriend.GiftsThisWeek == week + 1
            : acted && delivery!.completed.Value && afterFriend?.GiftsToday == today && afterFriend?.GiftsThisWeek == week);
        var rejected = operation == "gift" && sameContext && spent.Length == 0 && afterFriend?.GiftsToday == today && afterFriend?.GiftsThisWeek == week;
        var noTalk = operation == "talk" && !acted && sameContext && changes.Length == 0 && Game1.player.Money == beforeGold
            && JsonSerializer.Serialize(beforeFriend, LocalServer.Json) == JsonSerializer.Serialize(FriendshipFact(npc), LocalServer.Json)
            && JsonSerializer.Serialize(beforeQuests, LocalServer.Json) == JsonSerializer.Serialize(QuestFacts(), LocalServer.Json)
            && Game1.activeClickableMenu is null && !Game1.eventUp;
        return new { operation, npcName = npc.Name, locationId = location.NameOrUniqueName, date = GameFacts.Date(), questId = delivery?.id.Value,
            targetKey = delivery is null ? null : QuestActions.Key(delivery), confirmedEffect = confirmed,
            completionUncertain = !confirmed && !rejected && !noTalk, nativeActionReturned = acted,
            outcome = confirmed ? operation == "gift" ? "gifted" : operation == "deliver" ? "delivered" : "interaction_started" : rejected ? "rejected" : "not_started",
            offeredItemId = offer?.QualifiedItemId, offeredQuality = offer?.Quality, amountConsumed = confirmed ? required : 0,
            beforeFriendship = beforeFriend, afterFriendship = FriendshipFact(npc), beforeQuests, afterQuests = QuestFacts(),
            beforeItems, inventoryChanges = changes, beforeGold, afterGold = Game1.player.Money,
            dialogue = Dialogue(), eventStarted = Game1.eventUp,
            note = "Immediate native effect only; an open dialogue/question/event is not a completed social workflow. No gift/quest replay or direct reward claims." };
    }

    public static object Dialogue()
    {
        var box = Game1.activeClickableMenu as DialogueBox;
        if (box is null || box.GetChildMenu() is not null) return new { open = false, otherMenu = Game1.activeClickableMenu?.GetType().FullName, eventUp = Game1.eventUp };
        if (!ReferenceEquals(box, previousBox)) { previousBox = box; dialogueEpoch = Guid.NewGuid().ToString("N"); }
        var nativeSpeaker = box.characterDialogue?.speaker?.Name;
        var speaker = nativeSpeaker ?? (ReferenceEquals(box, boundBox) && boundSave == GameFacts.SaveId() && boundDay == GameFacts.DayKey() ? boundNpc : null);
        var text = box.getCurrentString();
        var revealed = box.characterIndexInDialogue >= text.Length - 1;
        var choicesReady = box.isQuestion && revealed && !box.transitioning && R.Bool(box, "_showedOptions");
        var options = (box.responses ?? Array.Empty<Response>()).Select((response, index) => new {
            index, key = response.responseKey, text = response.responseText,
            visible = choicesReady && box.responseCC is not null && box.responseCC.Count == box.responses.Length && index < box.responseCC.Count && box.responseCC[index].visible,
            bounds = box.responseCC is not null && index < box.responseCC.Count ? (object)R.Plain(box.responseCC[index].bounds)! : null,
        }).ToArray();
        // Exclude typing/transition timers: they change every frame while the semantic page
        // and exact responses stay the same. Include actual menu identity and page counts.
        var revision = GameFacts.Hash(JsonSerializer.Serialize(new { dialogueEpoch, speaker, text, box.isQuestion,
            page = box.characterDialogue?.currentDialogueIndex, lines = box.dialogues?.Count, brokenLines = box.characterDialoguesBrokenUp?.Count,
            box.x, box.y, box.width, box.height, options }, LocalServer.Json));
        return new { open = true, npcName = speaker, speakerSource = nativeSpeaker is not null ? "native_dialogue" : speaker is not null ? "current_native_interaction" : "unknown",
            text, isQuestion = box.isQuestion, revealed, choicesReady, options, revision, eventUp = Game1.eventUp,
            ready = !box.transitioning && box.safetyTimer <= 0 && box.characterAdvanceTimer <= 0 && box.questionFinishPauseTimer <= 0,
            note = "Only the currently displayed native page/options. Unknown speaker is not assigned from model text. Advance never chooses a response." };
    }
    public static Point DialoguePointer(JsonElement args)
    {
        var snapshot = Dialogue(); var npc = R.Arg(args, "npcName"); var box = Game1.activeClickableMenu as DialogueBox;
        InventoryActions.Require(!Game1.eventUp && R.Get(typeof(Game1), "currentMinigame") is null && npc.Length is > 0 and <= 128 && !npc.Any(char.IsControl) && box is not null && R.Bool(snapshot, "open") && R.Text(snapshot, "npcName") == npc
            && R.Text(snapshot, "revision") == R.Arg(args, "revision") && R.Text(snapshot, "text") == R.Arg(args, "expectedText"), "Dialogue identity or displayed text changed");
        var operation = R.Arg(args, "operation");
        Point point;
        if (operation is "advance" or "reveal")
        {
            InventoryActions.Require((operation == "reveal" || !box!.isQuestion) && box!.width > 0 && box.height > 0, "Advance cannot choose an answer or click unknown geometry");
            InventoryActions.Require(operation != "reveal" || !R.Bool(snapshot, "revealed"), "Current page is already revealed");
            point = new Point(box.x + box.width / 2, box.y + box.height / 2);
        }
        else
        {
            InventoryActions.Require(operation == "choose" && box!.isQuestion && R.Bool(snapshot, "choicesReady") && box.responses is not null && box.responseCC is not null && box.responses.Length == box.responseCC.Count, "Choose only from current visible native responses");
            var matches = Enumerable.Range(0, box!.responses.Length).Where(i => box.responses[i].responseKey == R.Arg(args, "responseKey")
                && box.responses[i].responseText == R.Arg(args, "responseText") && box.responseCC[i].visible).ToArray();
            InventoryActions.Require(matches.Length == 1, "Response key/text is not uniquely visible");
            point = box.responseCC[matches[0]].bounds.Center;
        }
        InventoryActions.Require(new Rectangle(0, 0, Game1.uiViewport.Width, Game1.uiViewport.Height).Contains(point), "Dialogue target is outside the current UI viewport");
        Game1.setMousePosition(point.X, point.Y, true);
        return point;
    }
    public static object DialogueClick(JsonElement args, Point point)
    {
        var before = Dialogue();
        if (!R.Bool(before, "open") || R.Text(before, "revision") != R.Arg(args, "revision")) return new { submitted = false, stale = true, after = before };
        InventoryActions.Require(R.Bool(before, "ready"), "Native dialogue is still transitioning");
        var box = (DialogueBox)Game1.activeClickableMenu;
        var beforeItems = InventoryActions.Counts(); var beforeGold = Game1.player.Money;
        var npcName = R.Text(before, "npcName"); var beforeFriendship = FriendshipFact(npcName); var beforeQuests = QuestFacts();
        var expected = DialoguePointer(args);
        InventoryActions.Require(expected == point, "Native response geometry changed");
        box.performHoverAction(point.X, point.Y);
        if (R.Arg(args, "operation") == "reveal") box.finishTyping();
        else box.receiveLeftClick(point.X, point.Y, false);
        if (ReferenceEquals(Game1.activeClickableMenu, box)) box.releaseLeftClick(point.X, point.Y);
        if (!ReferenceEquals(box, Game1.activeClickableMenu) && Game1.activeClickableMenu is DialogueBox next)
        { boundBox = next; boundNpc = npcName; boundSave = GameFacts.SaveId(); boundDay = GameFacts.DayKey(); }
        var changes = InventoryActions.Changes(beforeItems);
        var unapprovedCost = R.Arg(args, "operation") != "choose" && (Game1.player.Money < beforeGold || changes.Any(change => change.Amount < 0));
        return new { submitted = true, stale = false, before, after = Dialogue(), completedWorkflow = false,
            beforeGold, afterGold = Game1.player.Money, inventoryChanges = changes, beforeFriendship, afterFriendship = FriendshipFact(npcName),
            beforeQuests, afterQuests = QuestFacts(), completionUncertain = unapprovedCost,
            note = "One native displayed-page step; choices are explicit. Unexpected resource spending on automatic advance is unknown, not silently accepted." };
    }
}
