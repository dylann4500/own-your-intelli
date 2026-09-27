using System.Collections.Generic;

namespace QmEdge.Editor
{
    public interface IEdgeAdapter
    {
        string AdapterId { get; }

        bool ChangedWhileDetached { get; }

        void Attach(EdgeSession session);

        void Detach();

        void BeginSync();

        void Tick();

        void ApplyRemote(EdgeOperation operation, bool fromSnapshot);

        void OnOperationRejected(string resourceId, string effect, IList<string> keys);

        IEnumerable<EdgeAnnouncedResource> DescribeResources();
    }
}
