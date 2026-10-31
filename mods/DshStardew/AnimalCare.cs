using System.Globalization;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>Narrow animal identity/eligibility facts shared by read projection and native care.</summary>
internal static class AnimalCare
{
    public static FarmAnimal[] In(GameLocation location)
    {
        var values = R.Get(R.Get(location, "animals"), "Values")
            ?? throw new InvalidOperationException("Animal collection is unavailable, not known empty");
        return R.Items(values).Select(value => value as FarmAnimal
            ?? throw new InvalidOperationException("Unrecognized animal collection entry")).ToArray();
    }

    public static string Id(FarmAnimal animal) => animal.myID.Value.ToString(CultureInfo.InvariantCulture);
    public static string? ProduceId(FarmAnimal animal) => string.IsNullOrEmpty(animal.currentProduce.Value)
        ? null : ItemRegistry.QualifyItemId(animal.currentProduce.Value);
    // Verified in this build's MilkPail/Shears.DoFunction CIL: the cracker doubles native stack.
    public static int ProduceCount(FarmAnimal animal) => animal.hasEatenAnimalCracker.Value ? 2 : 1;
    public static long InventoryCount(string id, int quality) => Game1.player.Items.Where(item => item is not null && item.QualifiedItemId == id && item.Quality == quality).Sum(item => (long)item!.Stack);

    public static (int index, Tool tool)? ToolFor(string mode)
    {
        for (var i = 0; i < Game1.player.Items.Count; i++)
            if ((mode == "milk" && Game1.player.Items[i] is MilkPail) || (mode == "shear" && Game1.player.Items[i] is Shears))
                return (i, (Tool)Game1.player.Items[i]);
        return null;
    }

    public static FarmAnimal Find(string locationId, string animalId)
    {
        if (locationId != Game1.currentLocation.NameOrUniqueName) throw new InvalidOperationException("Animal must be in the current location");
        if (!long.TryParse(animalId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            || parsed.ToString(CultureInfo.InvariantCulture) != animalId) throw new ArgumentException("Use an actual queried animal ID");
        return In(Game1.currentLocation).SingleOrDefault(animal => animal.myID.Value == parsed)
            ?? throw new InvalidOperationException("Animal moved or is no longer in this location");
    }

    public static bool InReach(FarmAnimal animal)
    {
        return Math.Abs((int)animal.Tile.X - (int)Game1.player.Tile.X)
            + Math.Abs((int)animal.Tile.Y - (int)Game1.player.Tile.Y) <= 1;
    }

    public static object Project(FarmAnimal animal, GameLocation location)
    {
        var produce = ProduceId(animal);
        var count = ProduceCount(animal);
        var milk = ToolFor("milk"); var shear = ToolFor("shear");
        return new {
            animalId = Id(animal), name = animal.Name, animalType = animal.type.Value,
            position = new { locationId = location.NameOrUniqueName, x = (int)animal.Tile.X, y = (int)animal.Tile.Y },
            pettedToday = animal.wasPet.Value, autoPettedToday = animal.wasAutoPet.Value,
            adult = animal.isAdult(), ageDays = animal.age.Value,
            friendship = animal.friendshipTowardFarmer.Value, happiness = animal.happiness.Value, fullness = animal.fullness.Value,
            produceItemId = produce, produceQuality = produce is null ? (int?)null : animal.produceQuality.Value,
            produceCount = produce is null ? (int?)null : count,
            harvestType = animal.GetHarvestType()?.ToString(),
            harvestTool = R.Get(animal.GetAnimalData(), "HarvestTool"),
            canMilk = produce is not null && animal.isAdult() && milk is not null && animal.CanGetProduceWithTool(milk.Value.tool),
            canShear = produce is not null && animal.isAdult() && shear is not null && animal.CanGetProduceWithTool(shear.Value.tool),
            milkPailOwned = milk is not null, shearsOwned = shear is not null,
            inventoryCanAcceptProduce = produce is null ? (bool?)null : Game1.player.couldInventoryAcceptThisItem(produce, count, animal.produceQuality.Value),
        };
    }
}
