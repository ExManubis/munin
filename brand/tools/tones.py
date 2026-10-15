"""Sample facet tone (0 white .. 4 darkest, -1 outside) at arbitrary points."""
import numpy as np
from geo import inside
from facet import V, FACETS

FPOLYS = [(np.array([V[k] for k in keys.split()], float), t) for keys, t in FACETS]
EYE_C = (47.2, 38.6)


def tone_at(px, py):
    out = np.full(px.shape, -1, int)
    for P, t in FPOLYS:
        m = inside([P], px, py)
        out = np.where(m, t, out)
    return out


def eye_mask(px, py, s=2.9):
    ex, ey = EYE_C
    return (np.abs(px - ex) + np.abs(py - ey)) < s
