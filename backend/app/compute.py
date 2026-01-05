from typing import Tuple, List
import math

def line_line_intersection(a1: Tuple[float, float], a2: Tuple[float, float], b1: Tuple[float, float], b2: Tuple[float, float]):
    x1, y1 = a1
    x2, y2 = a2
    x3, y3 = b1
    x4, y4 = b2
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-12:
        return None
    px = ((x1*y2 - y1*x2)*(x3 - x4) - (x1 - x2)*(x3*y4 - y3*x4)) / den
    py = ((x1*y2 - y1*x2)*(y3 - y4) - (y1 - y2)*(x3*y4 - y3*x4)) / den
    # check within segments
    if min(x1,x2)-1e-9 <= px <= max(x1,x2)+1e-9 and min(y1,y2)-1e-9 <= py <= max(y1,y2)+1e-9 and \
       min(x3,x4)-1e-9 <= px <= max(x3,x4)+1e-9 and min(y3,y4)-1e-9 <= py <= max(y3,y4)+1e-9:
        return (px, py)
    return None


