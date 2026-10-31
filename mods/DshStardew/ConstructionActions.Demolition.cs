using System.Collections;
using System.Globalization;
using System.Text.Json;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Locations;
using StardewValley.Menus;

namespace DshStardew;

internal static partial class ConstructionActions
{
    // Read model first. No demolition control is registered until item recovery,
    // farmhand/cellar deletion and subclass effects have an execution receipt.
    private sealed record DemolitionQuestion(CarpenterMenu Root, GameLocation Target, Building Building, DialogueBox Box, Delegate Callback);
    private static DemolitionQuestion? DemolitionQuestionState()
    {
        if (!WorldReady() || Game1.activeClickableMenu?.GetType() != typeof(DialogueBox)
            || Game1.activeClickableMenu.GetChildMenu() is not null || !R.Bool(Game1.activeClickableMenu, "isQuestion")) return null;
        if (R.Get(Game1.currentLocation, "afterQuestion") is not Delegate callback || callback.GetInvocationList().Length != 1
            || callback.Method.Module != typeof(Game1).Module || callback.Method.MetadataToken != 0x060043ba
            || callback.Method.DeclaringType?.DeclaringType != typeof(CarpenterMenu)) return null;
        var capture = callback.Target;
        if (R.Get(capture, "<>4__this") is not CarpenterMenu root || root.GetType() != typeof(CarpenterMenu)
            || R.Get(capture, "farm") is not GameLocation target || R.Get(capture, "destroyed") is not Building building
            || !ReferenceEquals(root.TargetLocation, target) || !ReferenceEquals(Game1.currentLocation, target)
            || !root.onFarm || Convert.ToInt32(root.Action) != 1) return null;
        return new(root, target, building, (DialogueBox)Game1.activeClickableMenu, callback);
    }
    private static CarpenterMenu? DemolitionQuestionRoot() => DemolitionQuestionState()?.Root;
    private static object?[] DemolitionRows(object? source, int cap, bool allowNull = false)
    {
        InventoryActions.Require(source is IEnumerable && source is not string, "Demolition collection unavailable, not known empty");
        var rows = new List<object?>();
        foreach (var value in (IEnumerable)source!) {
            InventoryActions.Require(rows.Count < cap && (value is not null || allowNull), "Demolition collection is incomplete, null or exceeds its bound"); rows.Add(value);
        }
        return rows.ToArray();
    }
    private static Farmer[] DemolitionFarmhands()
    {
        var world = R.Get(typeof(Game1), "netWorldState");
        var rows = DemolitionRows(R.Get(world, "farmhandData"), 256);
        var farmers = rows.Select(row => {
            var value = R.Get(row, "Value"); InventoryActions.Require(value is Farmer, "Unresolved actual farmhand record");
            var farmer = (Farmer)value!;
            InventoryActions.Require(R.Get(row, "Key") is long id && id == farmer.UniqueMultiplayerID, "Farmhand dictionary identity mismatch"); return farmer;
        }).ToArray();
        InventoryActions.Require(farmers.Select(f => f.UniqueMultiplayerID).Distinct().Count() == farmers.Length, "Duplicate farmhand identities"); return farmers;
    }
    private static object DemolitionFarmer(Farmer f)
    {
        InventoryActions.Require(f.GetType() == typeof(Farmer), "Custom farmhand data needs its own loss projection");
        // Farmer.Items is exactly netItems.Value in this build. Read the actual
        // net reference, without constructing an inventory or resolving a home.
        var bag = DemolitionRows(R.Get(f, "netItems"), 256, true);
        InventoryActions.Require(bag.All(i => i is null or Item), "Unknown farmhand inventory slot");
        var remaining = 8192;
        var slots = new List<object?>(); foreach (var item in bag) slots.Add(MoveItem(item as Item, ref remaining));
        var gear = new[] { "hat", "boots", "leftRing", "rightRing", "shirtItem", "pantsItem", "cursorSlotItem", "temporaryItem" }
            .ToDictionary(name => name, name => R.Get(f, name) is { } item ? MoveItemFact(item) : null);
        var trinkets = MoveStoredItems(R.Get(f, "trinketItems"), 32);
        return new { farmerId = f.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), key = MineActions.Key(f), name = f.Name,
            active = f.isActive(), slots, gear, trinkets, bagRecovery = CabinBagRecovery(bag),
            deletionScope = "entire_farmhand_record_and_linked_player_friendship_edges_not_just_this_inventory",
            fullCharacterBackup = false, inventoryRecoveryPredictionComplete = false,
            note = "Native Cabin.demolish clears this bag, removes the lowest-upgrade tools of certain types and another native predicate match, then places remaining items in a new chest. Equipment and full progress are not promised recovered. No getOne/removeInitialTools/DeleteFarmhand invoked here." };
    }
    private static object DemolitionLocation(GameLocation location)
    {
        InventoryActions.Require(location.GetType().Assembly == typeof(Game1).Assembly, "Custom demolition interior requires its own effect model");
        var furniture = DemolitionRows(R.Get(location, "furniture"), 1024);
        InventoryActions.Require(furniture.All(v => v is Item), "Unknown actual furniture entry");
        var farmers = DemolitionRows(R.Get(location, "farmers"), 256);
        InventoryActions.Require(farmers.All(f => f is Farmer), "Unresolved interior farmer identity");
        var characters = DemolitionRows(R.Get(location, "characters"), 256);
        InventoryActions.Require(characters.All(c => c is Character && c.GetType().Assembly == typeof(Game1).Assembly), "Unknown interior character");
        var animals = AnimalCare.In(location); InventoryActions.Require(animals.Length <= 512, "Incomplete interior animal collection");
        return new { key = MineActions.Key(location), locationId = location.NameOrUniqueName, nativeType = location.GetType().FullName,
            objects = MovePairs(R.Get(location, "Objects"), 4096, MoveItemFact), furniture = furniture.Select(v => MoveItemFact(v!)).ToArray(),
            fridge = R.Get(location, "fridge") is Item fridge ? MoveItemFact(fridge) : null,
            farmers = farmers.Cast<Farmer>().Select(f => f.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture)).ToArray(),
            characters = characters.Cast<Character>().Select(c => new { key = MineActions.Key(c), type = c.GetType().FullName, name = c.Name }).ToArray(),
            animals = animals.Select(a => new { id = AnimalCare.Id(a), key = MineActions.Key(a), home = MoveHome(a) }).ToArray(),
            residents = DemolitionRows(R.Get(location, "animalsThatLiveHere") ?? Array.Empty<object>(), 256).Select(id => Convert.ToString(R.Unwrap(id), CultureInfo.InvariantCulture)).ToArray() };
    }
    private static object DemolitionCellar(Farmer? owner, bool ownerKnown)
    {
        var rows = DemolitionRows(R.Get(Game1.player.team, "cellarAssignments"), 256);
        var assignments = rows.Select(row => {
            InventoryActions.Require(R.Get(row, "Key") is int && R.Get(row, "Value") is long, "Unknown native cellar assignment");
            return new { index = (int)R.Get(row, "Key")!, farmerId = ((long)R.Get(row, "Value")!).ToString(CultureInfo.InvariantCulture) };
        }).ToArray();
        var matches = owner is null ? Array.Empty<int>() : assignments.Where(a => a.farmerId == owner.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture)).Select(a => a.index).ToArray();
        // Native GetCellarName uses 0/1 => Cellar and N => CellarN. Do not call
        // GetCellar: it resolves/loads a location and demolition resets its objects.
        var name = matches.Length != 1 || matches[0] == -1 ? null : matches[0] is 0 or 1 ? "Cellar" : "Cellar" + matches[0].ToString(CultureInfo.InvariantCulture);
        var loaded = name is null ? Array.Empty<GameLocation>() : Game1.locations.Where(l => l.NameOrUniqueName == name).Take(2).ToArray();
        InventoryActions.Require(loaded.Length <= 1, "Ambiguous loaded cellar identity");
        return new { assignments, name, assignmentAmbiguous = matches.Length > 1, loaded = loaded.Length == 1,
            snapshot = loaded.Length == 1 ? DemolitionLocation(loaded[0]) : null,
            complete = ownerKnown && matches.Length <= 1 && (name is null || loaded.Length == 1),
            note = "Native cabin demolition resets cellar objects and recalculates assignments. No cellar is created/resolved here; an unloaded cellar is unknown, not empty. Global reassignment effects still need a postcondition model." };
    }
    private static object DemolitionLock()
    {
        var mutex = R.Get(Game1.player.team, "demolishLock");
        InventoryActions.Require(mutex?.GetType().FullName == "StardewValley.Network.NetWitnessedLock" && R.Get(mutex, "requested") is bool, "Unknown native demolition lock");
        var callback = R.Get(mutex, "acquired") as Delegate; var native = callback?.GetInvocationList().Length == 1 && callback.Method.Module == typeof(Game1).Module && callback.Method.MetadataToken == 0x060043b9;
        var captured = native ? R.Get(callback!.Target, "destroyed") as Building : null;
        return new { requested = R.Bool(mutex, "requested"), callbackPending = callback is not null, callbackKey = callback is null ? null : MineActions.Key(callback),
            nativeCallback = native, buildingGuid = captured is null ? null : Fact(captured).BuildingGuid,
            note = "The inspected lock invokes acquired during its Update, then clears the callback/request/witnesses. A submitted callback can still run after controller stop; no read cancels it." };
    }
    private static object[] DemolitionDispatch(object target, params string[] names) => target.GetType().GetMethods(R.Flags)
        .Where(m => !m.IsStatic && names.Contains(m.Name)).OrderBy(m => m.Name, StringComparer.Ordinal).ThenBy(m => m.MetadataToken)
        .Select(m => (object)new { method = m.Name, declaringType = m.DeclaringType?.FullName, token = $"0x{m.MetadataToken:x8}",
            baseToken = $"0x{m.GetBaseDefinition().MetadataToken:x8}", native = m.Module == typeof(Game1).Module,
            parameters = m.GetParameters().Select(p => p.ParameterType.FullName).ToArray(), modeled = false }).ToArray();
    private static object? QueryDemolition(JsonElement args, GameLocation target)
    {
        if (!args.TryGetProperty("demolishBuildingGuid", out var id)) return null;
        try {
            var parsed = Guid.Empty;
            InventoryActions.Require(id.ValueKind == JsonValueKind.String && Guid.TryParseExact(id.GetString(), "D", out parsed) && parsed != Guid.Empty, "Use an exact persistent demolition building GUID");
            var guid = parsed.ToString("D"); var rows = Structures(target); var fact = rows.SingleOrDefault(b => b.BuildingGuid == guid);
            var hands = DemolitionFarmhands(); var q = DemolitionQuestionState();
            var root = RootMenu() ?? q?.Root;
            var state = new Dictionary<string, object?> { ["buildingGuid"] = guid, ["exists"] = fact is not null,
                ["nativeLock"] = DemolitionLock(), ["farmhandRoster"] = hands.Select(f => new { farmerId = f.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), key = MineActions.Key(f) }).ToArray(),
                ["returnedDonationsBefore"] = MoveStoredItems(R.Get(Game1.player.team, "returnedDonations"), 512),
                ["rootKey"] = root is null ? null : MineActions.Key(root), ["rootActive"] = root is not null && ReferenceEquals(root, Game1.activeClickableMenu),
                ["question"] = q is null ? null : new { buildingGuid = Fact(q.Building).BuildingGuid, rootKey = MineActions.Key(q.Root), boxKey = MineActions.Key(q.Box),
                    callbackKey = MineActions.Key(q.Callback), targetKey = MineActions.Key(q.Target), dialogue = SocialActions.Dialogue() } };
            if (fact is not null) {
                var building = MoveBuilding(target, guid); var interior = MoveInterior(building); var cabin = interior as Cabin;
                Farmer? owner = null; object? cabinState = null; object? cellarState = null;
                if (cabin is not null) {
                    var reference = R.Raw(cabin, "farmhandReference");
                    InventoryActions.Require(reference?.GetType().FullName == "StardewValley.Network.NetFarmerRef" && R.Get(reference, "defined") is bool && R.Get(reference, "uid") is long, "Unknown cabin farmhand reference");
                    var defined = R.Bool(reference, "defined"); var uid = (long)R.Get(reference, "uid")!;
                    owner = !defined ? null : hands.Concat(new[] { Game1.player }).SingleOrDefault(f => f.UniqueMultiplayerID == uid);
                    cellarState = DemolitionCellar(owner, !defined || owner is not null);
                    cabinState = new { ownerDefined = defined, ownerResolved = !defined || owner is not null, ownerId = defined ? uid.ToString(CultureInfo.InvariantCulture) : null,
                        owner = owner is null ? null : DemolitionFarmer(owner), cellar = cellarState,
                        recoveryPredictionComplete = false, deletesFarmhandProgress = owner is not null,
                        note = "Native cabin demolition clears the owner bag, filters tools, may create a recovery chest, relocates known NPCs/pets, resets cellar objects and deletes the farmhand record/friendship edges. This projection is not an authorized deletion or full backup." };
                }
                state["building"] = fact; state["colors"] = Colors(building); state["legacyTint"] = building.color.PackedValue;
                var contents = MoveProtected(building, target); var interiorState = interior is null ? null : DemolitionLocation(interior);
                state["buildingContents"] = contents; state["interior"] = interiorState;
                state["exits"] = MoveExits(building); state["cabin"] = cabinState;
                state["questItems"] = ObservedDemolitionQuestItems(contents, interiorState, cellarState);
                state["stableHorse"] = DemolitionHorse(building, target);
                // Report actual virtual dispatch instead of assuming every
                // native building/interior shares the base demolition effects.
                state["effectDispatch"] = new { building = DemolitionDispatch(building, "BeforeDemolish", "performActionOnDemolition", "ForEachItemExcludingInterior", "showDestroyedAnimation"),
                    interior = interior is null ? null : DemolitionDispatch(interior, "OnRemoved", "demolish", "DeleteFarmhand") };
                state["observedRules"] = new { underConstruction = fact.ConstructionDays > 0 || fact.UpgradeDays > 0,
                    nativeType = fact.NativeType, sameTypeBuildingCount = rows.Count(b => b.Type == fact.Type),
                    minimumCountRule = fact.Type is "Pet Bowl" or "Shipping Bin", protectedInteriorRule = fact.Type is "Farmhouse" or "Greenhouse",
                    nativeEligibilityEvaluated = false, note = "Native CanDemolishThis/continuation still check actual indoor identity, minimum counts, residents, farmers and activated cabin owner. These observations do not evaluate those handlers." };
            }
            // Readiness is deliberately separate from complete observed rosters.
            // Native quest-item cloning, initial-tool filtering, subtype hooks,
            // character/cellar removal and recovery chest receipts remain to model.
            state["executionReady"] = false; state["lossModelComplete"] = false;
            var element = JsonSerializer.SerializeToElement(state, LocalServer.Json);
            // Natural text reveal/readiness changes are not a new authorization
            // version; actual question controls will need their own input gate.
            var semanticQuestion = q is null ? null : new { root = MineActions.Key(q.Root), box = MineActions.Key(q.Box), callback = MineActions.Key(q.Callback),
                building = Fact(q.Building).BuildingGuid, text = JsonSerializer.SerializeToElement(SocialActions.Dialogue(), LocalServer.Json).GetProperty("text"),
                responses = DemolitionRows(R.Get(q.Box, "responses"), 16).Select(r => R.Fields(r, "responseKey", "responseText")).ToArray() };
            var revision = Hash(new { save = GameFacts.SaveId(), day = GameFacts.DayKey(), world = Revision(target),
                data = state.Where(p => p.Key != "question").ToDictionary(p => p.Key, p => p.Value), question = semanticQuestion });
            return new { available = true, observedCollectionsComplete = true, revision, state = element,
                note = "Read-only demolition preflight. All named collections are bounded or rejected; listed item fields are not a full save backup or exhaustive loss prediction. No eligibility handler, getInventory/getOne, cellar loader, lock request, question answer, callback, demolish or farmhand deletion invoked. No demolition control is enabled by this query." };
        } catch (PreconditionRejectedException e) { return new { available = false, observedCollectionsComplete = false, executionReady = false, reason = e.Message }; }
    }
}
