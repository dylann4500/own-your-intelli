using UnityEngine;

namespace QmEdge
{
    [DisallowMultipleComponent]
    [AddComponentMenu("QM Edge/QM Edge Identity")]
    public sealed class QmEdgeIdentity : MonoBehaviour
    {
        [SerializeField] string id;

        public string Id
        {
            get { return id; }
            set { id = value; }
        }
    }
}
