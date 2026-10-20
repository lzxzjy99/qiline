"""Independent executable reading of rules 2.1.0 revision 3, for audit only.

Not the production engine. Coordinates use consecutive A..S (including I).
Default: fixed groups of five; color-pressure is an explicit optional rule.
Undo is a low-level replay primitive; session consent is required separately.
"""
from dataclasses import dataclass, asdict
from copy import copy, deepcopy
from functools import lru_cache
import json

COLORS = (1, -1)
DELAYS = (0, 2, 4, 6, 8, 10, 12)
SIZES = (9, 13, 15, 19)
MODES = ('fixed-five', 'color-pressure')
RULES_VERSION = '2.1.0-r3-audit'

@dataclass(frozen=True)
class Config:
    size: int = 9
    delay: int = 4
    swap: bool = True
    four: bool = False
    ko: bool = True
    claim_mode: str = 'fixed-five'

    def __post_init__(self):
        if type(self.size) is not int or self.size not in SIZES:
            raise ValueError('INVALID_RULES')
        if type(self.delay) is not int or self.delay not in DELAYS:
            raise ValueError('INVALID_RULES')
        if any(type(x) is not bool for x in (self.swap, self.four, self.ko)):
            raise ValueError('INVALID_RULES')
        if self.claim_mode not in MODES or not isinstance(self.claim_mode,str):
            raise ValueError('INVALID_RULES')

def point(text, n):
    if not isinstance(text, str) or len(text) < 2 or not text[1:].isdigit():
        raise ValueError('OUT_OF_BOUNDS')
    x, y = ord(text[0]) - 65, int(text[1:]) - 1
    if not 0 <= x < n or not 0 <= y < n or text != chr(65+x)+str(y+1):
        raise ValueError('OUT_OF_BOUNDS')
    return y*n+x

def name(p, n):
    return chr(65+p % n)+str(p//n+1)

def neighbors(p, n):
    x, y = p % n, p // n
    return tuple(q for ok, q in ((x>0,p-1),(x<n-1,p+1),(y>0,p-n),(y<n-1,p+n)) if ok)

def group(board, p, n):
    seen, liberties, stack = {p}, set(), [p]
    while stack:
        for q in neighbors(stack.pop(), n):
            if board[q] == 0:
                liberties.add(q)
            elif board[q] == board[p] and q not in seen:
                seen.add(q); stack.append(q)
    return frozenset(seen), frozenset(liberties)

@lru_cache(maxsize=128)
def board_groups(board,n):
    """One immutable group/liberty table per board; reused across empty points."""
    info=[None]*len(board)
    for p,c in enumerate(board):
        if c and info[p] is None:
            g=group(board,p,n)
            for q in g[0]:info[q]=g
    return tuple(info)

def geometry_possible(board,p,color,n):
    """Fast exact geometry precheck. Superko still requires a simulated board."""
    if type(p) is not int or not 0<=p<n*n or board[p]:return False
    adj=neighbors(p,n)
    if any(board[q]==0 for q in adj):return True
    info=board_groups(board,n)
    return any((board[q]==color and len(info[q][1])>1) or
               (board[q]==-color and info[q][1]=={p}) for q in adj)

def place(board, p, color, n):
    """Geometry only: simultaneous deduplicated captures, then own liberties."""
    if type(p) is not int or not 0 <= p < n*n:
        raise ValueError('OUT_OF_BOUNDS')
    if board[p]:
        raise ValueError('OCCUPIED')
    b = list(board); b[p] = color
    captured, visited = set(), set()
    for q in neighbors(p, n):
        if b[q] == -color and q not in visited:
            stones, libs = group(b, q, n)
            visited.update(stones)
            if not libs:
                captured.update(stones)
    for q in captured:
        b[q] = 0
    if not group(b, p, n)[1]:
        raise ValueError('SUICIDE')
    return tuple(b), tuple(sorted(captured))

def five_windows(board, color, n, four=False):
    result = set()
    for dy, dx in ((1,1),(1,-1)) + (((0,1),(1,0)) if four else ()):
        for p, v in enumerate(board):
            x, y = p%n, p//n
            if v != color or not (0 <= x+4*dx < n and 0 <= y+4*dy < n):
                continue
            seq = tuple((y+k*dy)*n+x+k*dx for k in range(5))
            if all(board[q] == color for q in seq):
                result.add(seq)
    return frozenset(result)

class Match:
    def __init__(self, config=Config()):
        self.config = config
        self.board = (0,)*(config.size**2)
        self.phase = 'opening' if config.swap else 'playing'
        self.opened = 0
        self.to_move = 1
        self.owners = None if config.swap else {1:'A', -1:'B'}
        self.ply = self.placements = self.pass_streak = 0
        self.captures = {1:0, -1:0}
        self.claims = {}
        self.positions = [self.board]
        self.keys = {self.board}
        self.log, self.events = [], []
        self.outcome = None

    def clone(self):
        m = copy(self)
        for k in ('owners','captures','claims'):
            setattr(m, k, None if getattr(self,k) is None else dict(getattr(self,k)))
        m.positions, m.keys = list(self.positions), set(self.keys)
        m.log, m.events = list(self.log), list(self.events)
        return m

    def can_place(self, p, color=None, opening=False):
        if color is None:
            color = self.to_move
        if not geometry_possible(self.board,p,color,self.config.size):
            return False
        try:
            b, cap = place(self.board, p, color, self.config.size)
            if opening and cap:
                return False
            return not (self.config.ko and b in self.keys)
        except ValueError:
            return False

    def has_placement(self, color=None):
        return any(self.can_place(p, color) for p,v in enumerate(self.board) if v == 0)

    def legal_points(self):
        return [p for p,v in enumerate(self.board) if v == 0 and self.can_place(p)]

    def _settle(self):
        present = self.present_claims()
        for key in list(self.claims):
            if key not in present:
                del self.claims[key]
                self.events.append(('cancel', key, self.ply))
        mature = [(t,key) for key,t in self.claims.items() if self.ply >= t+self.config.delay]
        if mature:
            _, key = min(mature)
            self._end(('win', key[0], 'line'))
            return
        for key in sorted(present - self.claims.keys()):
            self.claims[key] = self.ply
            self.events.append(('claim', key, self.ply))
            if self.config.delay == 0:
                self._end(('win', key[0], 'line')); return
        if self.pass_streak >= 2 and not self.claims:
            self._end(('draw', 0, 'two-passes'))

    def present_claims(self):
        windows={c:five_windows(self.board,c,self.config.size,self.config.four) for c in COLORS}
        if self.config.claim_mode == 'fixed-five':
            return {(c,w) for c in COLORS for w in windows[c]}
        return {(c,()) for c in COLORS if windows[c]}

    @property
    def claim_times(self):
        """Earliest live formation for each color; actual state remains per five."""
        colors={key[0] for key in self.claims}
        return {c:min(t for key,t in self.claims.items() if key[0]==c) for c in colors}

    def _end(self, outcome):
        self.outcome, self.phase = outcome, 'finished'

    def _pass(self, forced):
        color = self.to_move
        self.ply += 1
        self.pass_streak = min(2, self.pass_streak+1)
        self.events.append(('forced-pass' if forced else 'pass',color,self.ply))
        self._settle()
        if not self.outcome:
            self.to_move *= -1

    def normalize(self):
        count = 0
        while self.phase == 'playing' and not self.has_placement():
            self._pass(True); count += 1
            # Safety assertion, not an extra game rule. A blocked state must
            # produce either an actionable turn, a draw or a due claim.
            assert count <= self.config.delay+2, 'forced-pass normalization failed to terminate'
        return count

    def apply(self, action):
        if self.outcome:
            raise ValueError('FINISHED')
        if not isinstance(action,dict) or action.get('actor') not in ('A','B'):
            raise ValueError('INVALID_ACTION')
        kind = action.get('kind')
        fields = {'place':{'kind','actor','point'},'pass':{'kind','actor'},
                  'choose':{'kind','actor','color'},'resign':{'kind','actor'},
                  'cancel-opening':{'kind','actor','approved_by'}}
        if not isinstance(kind,str) or kind not in fields or set(action) != fields[kind]:
            raise ValueError('INVALID_ACTION')
        m = self.clone()
        if kind == 'cancel-opening':
            if m.phase not in ('opening','choose'):
                raise ValueError('WRONG_PHASE')
            approvals=action['approved_by']
            if not isinstance(approvals,list) or len(approvals)!=2 or not all(x in ('A','B') for x in approvals) or set(approvals)!={'A','B'}:
                raise ValueError('CONSENT_REQUIRED')
            m._end(('cancelled',0,'opening-cancel'))
            m.log.append(deepcopy(action));return m
        if kind == 'resign':
            if m.phase != 'playing':
                raise ValueError('WRONG_PHASE')
            own = next(c for c in COLORS if m.owners[c] == action['actor'])
            m._end(('win',-own,'resign')); m.log.append(dict(action)); return m
        if m.phase == 'choose':
            if kind != 'choose':
                raise ValueError('WRONG_PHASE')
            if action['actor'] != 'B':
                raise ValueError('WRONG_ACTOR')
            c = action['color']
            if type(c) is not int or c not in COLORS:
                raise ValueError('INVALID_COLOR')
            m.owners, m.phase, m.to_move = {c:'B',-c:'A'},'playing',-1
            m.log.append(dict(action)); m.normalize(); return m
        if kind not in ('place','pass') or (m.phase == 'opening' and kind != 'place'):
            raise ValueError('WRONG_PHASE')
        color = (1,-1,1)[m.opened] if m.phase == 'opening' else m.to_move
        actor = 'A' if m.phase == 'opening' else m.owners[color]
        if action['actor'] != actor:
            raise ValueError('WRONG_ACTOR')
        if kind == 'pass':
            m.log.append(dict(action)); m._pass(False)
        else:
            b, captured = place(m.board,action['point'],color,m.config.size)
            if m.phase == 'opening' and captured:
                raise ValueError('OPENING_CAPTURE')
            if m.config.ko and b in m.keys:
                raise ValueError('REPETITION')
            m.board = b; m.positions.append(b); m.keys.add(b)
            m.ply += 1; m.placements += 1; m.pass_streak = 0
            m.captures[color] += len(captured)
            m.events.append(('place',color,action['point'],captured,m.ply))
            m.log.append(dict(action))
            if m.phase == 'opening':
                m.opened += 1
                if m.opened == 3:
                    m.phase = 'choose'
                return m
            m._settle()
            if not m.outcome:
                m.to_move *= -1
        m.normalize()
        return m

    def action(self, kind, coord=None, actor=None, **kwargs):
        if self.outcome:
            raise ValueError('FINISHED')
        if actor is None:
            actor = 'A' if self.phase == 'opening' else ('B' if self.phase == 'choose' else self.owners[self.to_move])
        a = dict(kind=kind,actor=actor,**kwargs)
        if coord is not None:
            a['point'] = point(coord,self.config.size) if isinstance(coord,str) else coord
        return self.apply(a)

    def signature(self):
        return (self.config,self.board,self.phase,self.opened,self.to_move,
                None if self.owners is None else tuple(sorted(self.owners.items())),
                self.ply,self.placements,self.pass_streak,tuple(sorted(self.captures.items())),
                tuple(sorted(self.claims.items())),tuple(self.positions),frozenset(self.keys),
                json.dumps(self.log,sort_keys=True),self.outcome,repr(self.events))

    def record(self):
        return {'schemaVersion':1,'rulesVersion':RULES_VERSION,
                'rules':asdict(self.config),'actions':deepcopy(self.log)}

    @classmethod
    def replay(cls, record):
        if not isinstance(record,dict) or set(record) != {'schemaVersion','rulesVersion','rules','actions'}:
            raise ValueError('INVALID_RECORD')
        if type(record['schemaVersion']) is not int or record['schemaVersion'] != 1 or record['rulesVersion'] != RULES_VERSION:
            raise ValueError('UNSUPPORTED_VERSION')
        if not isinstance(record['rules'],dict) or set(record['rules']) != {'size','delay','swap','four','ko','claim_mode'} or not isinstance(record['actions'],list):
            raise ValueError('INVALID_RECORD')
        m = cls(Config(**record['rules']))
        for a in record['actions']:
            m = m.apply(a)
        return m

    def undo(self, commands=1):
        if self.outcome:
            raise ValueError('FINISHED')
        if type(commands) is not int or commands != 1:
            raise ValueError('INVALID_UNDO')
        if not self.log:
            raise ValueError('NO_UNDO')
        r = self.record(); r['actions'] = r['actions'][:-commands]
        return self.replay(r)

def projection(black=(),white=(),config=Config(swap=False),to_move=-1,ply=20,claims=None):
    """Synthetic state; MUST NOT be reported as a legal game from the empty board."""
    m = Match(config)
    b = list(m.board)
    for c, coords in ((1,black),(-1,white)):
        for text in coords:
            p = point(text,config.size)
            assert not b[p],text
            b[p] = c
    m.board = tuple(b); m.positions = [m.board]; m.keys = {m.board}
    m.to_move, m.ply, m.placements = to_move,ply,sum(v!=0 for v in b)
    times=dict(claims or {})
    m.claims = {key:times[key[0]] for key in m.present_claims() if key[0] in times}
    return m
