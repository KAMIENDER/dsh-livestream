using System.Collections;
using System.Reflection;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;

namespace DshStardew;

/// <summary>Read-only compatibility boundary. Missing facts stay null; never write fields through reflection.</summary>
internal static class R
{
    internal const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    public static object? Raw(object? source, string name)
    {
        if (source is null) return null;
        var type = source as Type ?? source.GetType();
        var instance = source is Type ? null : source;
        for (var t = type; t is not null; t = t.BaseType)
        {
            var field = t.GetField(name, Flags | BindingFlags.DeclaredOnly);
            if (field is not null) return field.GetValue(instance);
            var property = t.GetProperty(name, Flags | BindingFlags.DeclaredOnly);
            if (property is not null && property.GetIndexParameters().Length == 0)
                return property.GetValue(instance);
        }
        return null;
    }

    public static object? Unwrap(object? value)
    {
        for (var i = 0; i < 4 && value is not null; i++)
        {
            if (!(value.GetType().Namespace?.StartsWith("Netcode", StringComparison.Ordinal) ?? false)) break;
            var property = value.GetType().GetProperty("Value");
            if (property is null || property.GetIndexParameters().Length != 0) break;
            var next = property.GetValue(value);
            if (ReferenceEquals(next, value)) break;
            value = next;
        }
        return value;
    }

    public static object? Get(object? source, string name) => Unwrap(Raw(source, name));
    public static string Text(object? source, string name) => Convert.ToString(Get(source, name), System.Globalization.CultureInfo.InvariantCulture) ?? "";
    public static bool Bool(object? source, string name) => Get(source, name) is true;
    public static double Number(object? source, string name)
    {
        var value = Get(source, name) ?? throw new InvalidOperationException($"Required field unavailable: {name}");
        return Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    public static IEnumerable<object> Items(object? value)
    {
        if (Unwrap(value) is not IEnumerable sequence || value is string) yield break;
        foreach (var entry in sequence) if (entry is not null) yield return entry;
    }

    public static object? Plain(object? value, int depth = 0)
    {
        value = Unwrap(value);
        if (value is null || value is string || value is bool || value is decimal || value.GetType().IsPrimitive) return value;
        if (value is Enum) return value.ToString();
        if (value is Vector2 v) return new { x = v.X, y = v.Y };
        if (value is Point p) return new { x = p.X, y = p.Y };
        if (value is Rectangle rect) return new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height };
        if (depth >= 3) return null;
        if (value is IEnumerable && value is not string)
            return Items(value).Take(128).Select(entry =>
                Raw(entry, "Key") is { } key
                    ? (object)new { key = Plain(key, depth + 1), value = Plain(Raw(entry, "Value"), depth + 1) }
                    : Plain(entry, depth + 1)!).ToArray();
        return null;
    }

    public static object? Describe(object? value, int depth = 0)
    {
        value = Unwrap(value);
        if (value is null) return null;
        if (value is Item item) return new { id = item.QualifiedItemId, name = item.DisplayName, count = item.Stack,
            quality = item is StardewValley.Object obj ? obj.Quality : 0 };
        if (value is string || value is bool || value is decimal || value.GetType().IsPrimitive || value is Enum || value is Vector2 || value is Point || value is Rectangle) return Plain(value);
        if (depth >= 3) return null;
        if (value is IEnumerable sequence)
            return Items(sequence).Take(128).Select(entry => Raw(entry, "Key") is { } key
                ? (object)new { key = Describe(key, depth + 1), value = Describe(Raw(entry, "Value"), depth + 1) }
                : Describe(entry, depth + 1)!).ToArray();
        var type = value.GetType();
        // Only small gameplay descriptors, never textures, delegates, menu parents or an arbitrary object graph.
        if (!(type.Namespace?.StartsWith("StardewValley.GameData", StringComparison.Ordinal) ?? false)
            && !new[] { "Blueprint", "Bundle", "Ingredient", "Objective", "Reward", "SchedulePath", "WorldDate" }.Any(part => type.Name.Contains(part, StringComparison.Ordinal))) return null;
        return type.GetFields(BindingFlags.Public | BindingFlags.Instance).Take(64)
            .ToDictionary(field => field.Name, field => Describe(field.GetValue(value), depth + 1));
    }

    public static Dictionary<string, object?> Fields(object? source, params string[] names) =>
        names.ToDictionary(name => name, name => Describe(Get(source, name)));

    public static Dictionary<string, object?> Scalars(object? source)
    {
        var result = new Dictionary<string, object?>();
        if (source is null) return result;
        foreach (var field in source.GetType().GetFields(Flags).Where(f => !f.IsStatic).OrderBy(f => f.Name).Take(128))
        {
            var value = Unwrap(field.GetValue(source));
            if (value is null || value is string || value is bool || value.GetType().IsPrimitive || value is Enum)
                result[field.Name] = Plain(value);
        }
        return result;
    }

    public static string Arg(JsonElement args, string key, string fallback = "") =>
        args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : fallback;
    public static int Int(JsonElement args, string key, int fallback, int min, int max)
    {
        var value = args.TryGetProperty(key, out var node) ? node.GetInt32() : fallback;
        if (value < min || value > max) throw new ArgumentException($"{key} must be {min}..{max}");
        return value;
    }
}
