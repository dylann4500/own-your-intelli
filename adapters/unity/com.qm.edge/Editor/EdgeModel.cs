using System.Collections.Generic;
using System.Text;

namespace QmEdge.Editor
{
    public static class EdgeEffect
    {
        public const string Create = "create";
        public const string Update = "update";
        public const string Delete = "delete";
        public const string None = "none";
    }

    public static class EdgeText
    {
        public const int MaxIdLength = 256;

        public static string Clean(string value, int maxLength)
        {
            if (value == null) return null;
            var builder = new StringBuilder(value.Length);
            foreach (char c in value)
            {
                if (c >= ' ' && c != '\u007f') builder.Append(c);
            }
            string cleaned = TrimSpace(builder.ToString());
            if (cleaned.Length > maxLength) cleaned = TrimSpace(cleaned.Substring(0, maxLength));
            if (cleaned.Length > 0 && char.IsHighSurrogate(cleaned[cleaned.Length - 1])) cleaned = TrimSpace(cleaned.Substring(0, cleaned.Length - 1));
            return cleaned.Length == 0 ? null : cleaned;
        }

        static string TrimSpace(string value)
        {
            int start = 0;
            int end = value.Length;
            while (start < end && IsTrimmable(value[start])) start++;
            while (end > start && IsTrimmable(value[end - 1])) end--;
            return value.Substring(start, end - start);
        }

        static bool IsTrimmable(char c)
        {
            return char.IsWhiteSpace(c) || c == '\ufeff';
        }

        public static bool IsValidId(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > MaxIdLength) return false;
            foreach (char c in value)
            {
                if (c < ' ' || c == '\u007f') return false;
            }
            return true;
        }
    }

    public sealed class EdgeSettings
    {
        public string HubUrl;
        public string ProjectId;
        public string DisplayName;
        public string ActorId;
        public string Token;
        public string NodeId;
        public string DeviceName;
    }

    public sealed class EdgeOperation
    {
        public string Id;
        public string ProjectId;
        public string ActorId;
        public string NodeId;
        public string Adapter;
        public string ResourceType;
        public string ResourceId;
        public string Action;
        public string Effect;
        public string Label;
        public long? ClientTimestamp;
        public Dictionary<string, object> Payload = new Dictionary<string, object>();
        public Dictionary<string, object> ResourceProperties;
        public long Sequence;
        public string ActorDisplayName;
        public string ActorType;

        public Dictionary<string, object> ToSubmission(int protocolVersion)
        {
            var map = new Dictionary<string, object>
            {
                { "id", Id },
                { "protocolVersion", protocolVersion },
                { "projectId", ProjectId },
                { "actorId", ActorId }
            };
            if (!string.IsNullOrEmpty(NodeId)) map["nodeId"] = NodeId;
            map["adapter"] = Adapter;
            map["resourceType"] = ResourceType;
            map["resourceId"] = ResourceId;
            map["action"] = Action;
            map["effect"] = Effect;
            map["payload"] = Payload ?? new Dictionary<string, object>();
            if (!string.IsNullOrEmpty(Label)) map["label"] = Label;
            if (ClientTimestamp.HasValue) map["clientTimestamp"] = ClientTimestamp.Value;
            return map;
        }

        public static EdgeOperation FromJson(Dictionary<string, object> map)
        {
            if (map == null) return null;
            var operation = new EdgeOperation
            {
                Id = Json.GetString(map, "id"),
                ProjectId = Json.GetString(map, "projectId"),
                ActorId = Json.GetString(map, "actorId"),
                NodeId = Json.GetString(map, "nodeId"),
                Adapter = Json.GetString(map, "adapter"),
                ResourceType = Json.GetString(map, "resourceType"),
                ResourceId = Json.GetString(map, "resourceId"),
                Action = Json.GetString(map, "action"),
                Effect = Json.GetString(map, "effect"),
                Label = Json.GetString(map, "label"),
                Payload = Json.GetObject(map, "payload") ?? new Dictionary<string, object>(),
                Sequence = Json.GetLong(map, "sequence") ?? 0
            };
            if (operation.Id == null || operation.Adapter == null || operation.ResourceType == null || operation.ResourceId == null || operation.Effect == null) return null;
            double? timestamp = Json.GetDouble(map, "clientTimestamp");
            if (timestamp.HasValue) operation.ClientTimestamp = (long)timestamp.Value;
            Dictionary<string, object> actor = Json.GetObject(map, "actor");
            operation.ActorDisplayName = Json.GetString(actor, "displayName") ?? operation.ActorId;
            operation.ActorType = Json.GetString(actor, "type");
            return operation;
        }
    }

    public sealed class EdgeResourceState
    {
        public string Adapter;
        public string ResourceType;
        public string ResourceId;
        public bool Exists;
        public Dictionary<string, object> Properties = new Dictionary<string, object>();
        public Dictionary<string, long> Versions = new Dictionary<string, long>();
        public long? CreatedSequence;
        public long? DeletedSequence;
        public long LastSequence;

        public static EdgeResourceState FromJson(Dictionary<string, object> map)
        {
            if (map == null) return null;
            var state = new EdgeResourceState
            {
                Adapter = Json.GetString(map, "adapter"),
                ResourceType = Json.GetString(map, "resourceType"),
                ResourceId = Json.GetString(map, "resourceId"),
                Exists = Json.GetBool(map, "exists"),
                Properties = Json.GetObject(map, "properties") ?? new Dictionary<string, object>(),
                CreatedSequence = Json.GetLong(map, "createdSequence"),
                DeletedSequence = Json.GetLong(map, "deletedSequence"),
                LastSequence = Json.GetLong(map, "lastSequence") ?? 0
            };
            if (state.Adapter == null || state.ResourceType == null || state.ResourceId == null) return null;
            Dictionary<string, object> versions = Json.GetObject(map, "versions");
            if (versions != null)
            {
                foreach (string key in versions.Keys)
                {
                    long? version = Json.GetLong(versions, key);
                    if (version.HasValue) state.Versions[key] = version.Value;
                }
            }
            return state;
        }
    }

    public sealed class EdgeAnnouncedResource
    {
        public string ResourceType;
        public string ResourceId;
        public Dictionary<string, object> Properties = new Dictionary<string, object>();

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                { "resourceType", ResourceType },
                { "resourceId", ResourceId },
                { "properties", Properties ?? new Dictionary<string, object>() }
            };
        }
    }

    public sealed class EdgeMember
    {
        public string ActorId;
        public string DisplayName;
        public string ActorType;
        public string NodeId;
        public string Adapter;
        public string DeviceName;
        public string Status;
        public string WorkingOnResourceType;
        public string WorkingOnResourceId;
        public string WorkingOnLabel;

        public static EdgeMember FromJson(Dictionary<string, object> map)
        {
            if (map == null) return null;
            Dictionary<string, object> workingOn = Json.GetObject(map, "workingOn");
            return new EdgeMember
            {
                ActorId = Json.GetString(map, "actorId"),
                DisplayName = Json.GetString(map, "displayName"),
                ActorType = Json.GetString(map, "actorType"),
                NodeId = Json.GetString(map, "nodeId"),
                Adapter = Json.GetString(map, "adapter"),
                DeviceName = Json.GetString(map, "deviceName"),
                Status = Json.GetString(map, "status"),
                WorkingOnResourceType = Json.GetString(workingOn, "resourceType"),
                WorkingOnResourceId = Json.GetString(workingOn, "resourceId"),
                WorkingOnLabel = Json.GetString(workingOn, "label")
            };
        }
    }

    public sealed class EdgeEventEntry
    {
        public long Sequence;
        public string ActorId;
        public string ActorName;
        public string ResourceType;
        public string ResourceId;
        public string Action;
        public string Text;
        public int Count;
        public string CoalesceKey;
    }
}
