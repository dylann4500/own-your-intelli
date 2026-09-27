using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace QmEdge.Editor
{
    public static class Json
    {
        const int MaxDepth = 256;

        public static object Parse(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));
            return new Reader(text).ReadDocument();
        }

        public static string Serialize(object value)
        {
            var builder = new StringBuilder(256);
            WriteValue(builder, value, 0);
            return builder.ToString();
        }

        public static string GetString(IDictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            return value as string;
        }

        public static bool GetBool(IDictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return false;
            return value is bool && (bool)value;
        }

        public static Dictionary<string, object> GetObject(IDictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        public static List<object> GetArray(IDictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            return value as List<object>;
        }

        public static double? GetDouble(IDictionary<string, object> map, string key)
        {
            object value;
            double number;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            if (!TryGetNumber(value, out number) || double.IsNaN(number) || double.IsInfinity(number)) return null;
            return number;
        }

        public static long? GetLong(IDictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            if (value is long) return (long)value;
            if (value is int) return (int)value;
            double number;
            if (!TryGetNumber(value, out number)) return null;
            if (number < -9.2e18 || number > 9.2e18 || Math.Floor(number) != number) return null;
            return (long)number;
        }

        public static bool TryGetNumber(object value, out double number)
        {
            if (value is long) { number = (long)value; return true; }
            if (value is double) { number = (double)value; return true; }
            if (value is int) { number = (int)value; return true; }
            if (value is float) { number = (float)value; return true; }
            number = 0;
            return false;
        }

        static void WriteValue(StringBuilder builder, object value, int depth)
        {
            if (depth > MaxDepth) throw new InvalidOperationException("JSON value is nested too deeply");
            if (value == null) { builder.Append("null"); return; }
            var text = value as string;
            if (text != null) { WriteString(builder, text); return; }
            if (value is bool) { builder.Append((bool)value ? "true" : "false"); return; }
            if (value is double) { WriteDouble(builder, (double)value); return; }
            if (value is float) { WriteFloat(builder, (float)value); return; }
            if (value is int) { builder.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is long) { builder.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is uint || value is ulong || value is short || value is ushort || value is byte || value is sbyte || value is decimal)
            {
                builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            var map = value as IDictionary<string, object>;
            if (map != null) { WriteObject(builder, map, depth); return; }
            var sequence = value as IEnumerable;
            if (sequence != null) { WriteArray(builder, sequence, depth); return; }
            WriteString(builder, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        static void WriteObject(StringBuilder builder, IDictionary<string, object> map, int depth)
        {
            builder.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object> entry in map)
            {
                if (!first) builder.Append(',');
                first = false;
                WriteString(builder, entry.Key ?? "");
                builder.Append(':');
                WriteValue(builder, entry.Value, depth + 1);
            }
            builder.Append('}');
        }

        static void WriteArray(StringBuilder builder, IEnumerable sequence, int depth)
        {
            builder.Append('[');
            bool first = true;
            foreach (object item in sequence)
            {
                if (!first) builder.Append(',');
                first = false;
                WriteValue(builder, item, depth + 1);
            }
            builder.Append(']');
        }

        static void WriteDouble(StringBuilder builder, double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) { builder.Append("null"); return; }
            builder.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteFloat(StringBuilder builder, float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) { builder.Append("null"); return; }
            builder.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder builder, string value)
        {
            builder.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < ' ' || c == '\u007f' || c == '\u2028' || c == '\u2029')
                        {
                            builder.Append("\\u");
                            builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(c);
                        }
                        break;
                }
            }
            builder.Append('"');
        }

        sealed class Reader
        {
            readonly string text;
            int position;

            public Reader(string text)
            {
                this.text = text;
            }

            char Current
            {
                get { return position < text.Length ? text[position] : '\0'; }
            }

            public object ReadDocument()
            {
                object value = ReadValue(0);
                SkipWhitespace();
                if (position != text.Length) throw Error("unexpected trailing characters");
                return value;
            }

            object ReadValue(int depth)
            {
                if (depth > MaxDepth) throw Error("nesting is too deep");
                SkipWhitespace();
                if (position >= text.Length) throw Error("unexpected end of input");
                char c = text[position];
                switch (c)
                {
                    case '{': return ReadObject(depth);
                    case '[': return ReadArray(depth);
                    case '"': return ReadString();
                    case 't': ExpectLiteral("true"); return true;
                    case 'f': ExpectLiteral("false"); return false;
                    case 'n': ExpectLiteral("null"); return null;
                    default:
                        if (c == '-' || IsDigit(c)) return ReadNumber();
                        throw Error("unexpected character");
                }
            }

            Dictionary<string, object> ReadObject(int depth)
            {
                var map = new Dictionary<string, object>();
                position++;
                SkipWhitespace();
                if (Current == '}')
                {
                    position++;
                    return map;
                }
                while (true)
                {
                    SkipWhitespace();
                    if (Current != '"') throw Error("expected a property name");
                    string key = ReadString();
                    SkipWhitespace();
                    if (Current != ':') throw Error("expected ':'");
                    position++;
                    map[key] = ReadValue(depth + 1);
                    SkipWhitespace();
                    char next = Current;
                    if (position >= text.Length) throw Error("unterminated object");
                    position++;
                    if (next == ',') continue;
                    if (next == '}') return map;
                    throw Error("expected ',' or '}'");
                }
            }

            List<object> ReadArray(int depth)
            {
                var list = new List<object>();
                position++;
                SkipWhitespace();
                if (Current == ']')
                {
                    position++;
                    return list;
                }
                while (true)
                {
                    list.Add(ReadValue(depth + 1));
                    SkipWhitespace();
                    char next = Current;
                    if (position >= text.Length) throw Error("unterminated array");
                    position++;
                    if (next == ',') continue;
                    if (next == ']') return list;
                    throw Error("expected ',' or ']'");
                }
            }

            string ReadString()
            {
                position++;
                StringBuilder builder = null;
                int runStart = position;
                while (true)
                {
                    if (position >= text.Length) throw Error("unterminated string");
                    char c = text[position];
                    if (c == '"')
                    {
                        string run = text.Substring(runStart, position - runStart);
                        position++;
                        if (builder == null) return run;
                        builder.Append(run);
                        return builder.ToString();
                    }
                    if (c < ' ') throw Error("control character in string");
                    if (c != '\\')
                    {
                        position++;
                        continue;
                    }
                    if (builder == null) builder = new StringBuilder();
                    builder.Append(text, runStart, position - runStart);
                    position++;
                    if (position >= text.Length) throw Error("unterminated escape");
                    char escape = text[position++];
                    switch (escape)
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u': builder.Append(ReadHex4()); break;
                        default: throw Error("invalid escape sequence");
                    }
                    runStart = position;
                }
            }

            char ReadHex4()
            {
                if (position + 4 > text.Length) throw Error("truncated unicode escape");
                int code = 0;
                for (int i = 0; i < 4; i++)
                {
                    char c = text[position++];
                    int digit;
                    if (c >= '0' && c <= '9') digit = c - '0';
                    else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
                    else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
                    else throw Error("invalid unicode escape");
                    code = code * 16 + digit;
                }
                return (char)code;
            }

            object ReadNumber()
            {
                int start = position;
                bool integral = true;
                if (Current == '-') position++;
                if (Current == '0')
                {
                    position++;
                }
                else if (IsDigit(Current))
                {
                    while (IsDigit(Current)) position++;
                }
                else
                {
                    throw Error("invalid number");
                }
                if (Current == '.')
                {
                    integral = false;
                    position++;
                    if (!IsDigit(Current)) throw Error("invalid number");
                    while (IsDigit(Current)) position++;
                }
                if (Current == 'e' || Current == 'E')
                {
                    integral = false;
                    position++;
                    if (Current == '+' || Current == '-') position++;
                    if (!IsDigit(Current)) throw Error("invalid number");
                    while (IsDigit(Current)) position++;
                }
                string token = text.Substring(start, position - start);
                long whole;
                if (integral && long.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out whole)) return whole;
                double real;
                if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out real)) throw Error("number out of range");
                return real;
            }

            void ExpectLiteral(string literal)
            {
                if (string.CompareOrdinal(text, position, literal, 0, literal.Length) != 0) throw Error("invalid literal");
                position += literal.Length;
            }

            void SkipWhitespace()
            {
                while (position < text.Length)
                {
                    char c = text[position];
                    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
                    position++;
                }
            }

            static bool IsDigit(char c)
            {
                return c >= '0' && c <= '9';
            }

            FormatException Error(string message)
            {
                return new FormatException("Invalid JSON at position " + position.ToString(CultureInfo.InvariantCulture) + ": " + message);
            }
        }
    }
}
