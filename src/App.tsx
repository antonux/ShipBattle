import './App.css'
import { useState, useEffect, useCallback } from 'react';
import { db } from './firebase';
import { 
  doc, onSnapshot, updateDoc, setDoc, getDoc, 
  deleteDoc, serverTimestamp, Timestamp 
} from 'firebase/firestore';

// --- CONFIG ---
const GRID_SIZE = 10;
const SHIPS_CONFIG = [
  { name: 'Carrier', length: 5 },
  { name: 'Battleship', length: 4 },
  { name: 'Cruiser', length: 3 },
  { name: 'Submarine', length: 3 },
  { name: 'Destroyer', length: 2 },
];

// --- TYPES ---
type CellStatus = 'water' | 'hit' | 'miss';
interface Coord { r: number; c: number; }
interface ShipInstance {
  name: string;
  coords: Coord[];
  sunk: boolean;
}
interface Attack extends Coord { status: CellStatus; }

interface GameState {
  p1Ships: ShipInstance[];
  p2Ships: ShipInstance[];
  p1Attacks: Attack[];
  p2Attacks: Attack[];
  turn: 1 | 2;
  status: 'placement' | 'playing' | 'gameOver';
  winner: number | null;
  lastUpdated: Timestamp;
}

export default function BattleShipAdvanced() {
  const [roomInput, setRoomInput] = useState("");
  const [gameId, setGameId] = useState("");
  const [playerId, setPlayerId] = useState<1 | 2 | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  
  const [placedShips, setPlacedShips] = useState<ShipInstance[]>([]);
  const [orientation, setOrientation] = useState<'H' | 'V'>('H');
  const [hoverPos, setHoverPos] = useState<Coord | null>(null);
  const [isReady, setIsReady] = useState(false);

  // 1. ROTATE LISTENER
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r') setOrientation(prev => (prev === 'H' ? 'V' : 'H'));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 2. JOIN + INACTIVITY CHECK
  const joinGame = async (id: string, slot: 1 | 2) => {
    const cleanId = id.trim().toLowerCase();
    if (!cleanId) return alert("Enter Room ID");
    
    try {
      const docRef = doc(db, "games", cleanId);
      const snap = await getDoc(docRef);
      
      const initializeRoom = async () => {
        await setDoc(docRef, {
          p1Ships: [], p2Ships: [], p1Attacks: [], p2Attacks: [],
          turn: 1, status: 'placement', winner: null,
          lastUpdated: serverTimestamp()
        });
      };

      if (snap.exists()) {
        const data = snap.data() as GameState;
        const lastMillis = data.lastUpdated?.toMillis() || 0;
        const fiveMinutes = 5 * 60 * 1000;

        // If inactive > 5 mins, wipe and restart
        if (Date.now() - lastMillis > fiveMinutes) {
          await initializeRoom();
        }
      } else {
        await initializeRoom();
      }

      setGameId(cleanId);
      setPlayerId(slot);
    } catch (e) { alert("Firebase Error."); }
  };

  // 3. REAL-TIME SYNC
  useEffect(() => {
    if (!gameId) return;
    const unsub = onSnapshot(doc(db, "games", gameId), (s) => {
      if (s.exists()) {
        const data = s.data() as GameState;
        setGame(data);
        if (data.status === 'placement' && data.p1Ships.length === 5 && data.p2Ships.length === 5) {
          updateDoc(doc(db, "games", gameId), { status: 'playing', lastUpdated: serverTimestamp() });
        }
      }
    });
    return () => unsub();
  }, [gameId]);

  // 4. SHIP PLACEMENT HELPERS
  const getAdjustedCoords = useCallback((r: number, c: number, len: number, orient: 'H' | 'V'): Coord[] => {
    let startR = r, startC = c;
    if (orient === 'H') { if (c + len > GRID_SIZE) startC = GRID_SIZE - len; }
    else { if (r + len > GRID_SIZE) startR = GRID_SIZE - len; }
    const coords: Coord[] = [];
    for (let i = 0; i < len; i++) {
      coords.push(orient === 'H' ? { r: startR, c: startC + i } : { r: startR + i, c: startC });
    }
    return coords;
  }, []);

  const handlePlaceShip = () => {
    if (!hoverPos || placedShips.length >= 5) return;
    const currentConfig = SHIPS_CONFIG[placedShips.length];
    const coords = getAdjustedCoords(hoverPos.r, hoverPos.c, currentConfig.length, orientation);
    const overlap = coords.some(c => placedShips.flatMap(s => s.coords).some(ec => ec.r === c.r && ec.c === c.c));
    if (overlap) return;
    setPlacedShips([...placedShips, { name: currentConfig.name, coords, sunk: false }]);
  };

  const submitShips = async () => {
    setIsReady(true);
    const field = playerId === 1 ? 'p1Ships' : 'p2Ships';
    await updateDoc(doc(db, "games", gameId), { [field]: placedShips, lastUpdated: serverTimestamp() });
  };

  // 5. ATTACK LOGIC
  const handleAttack = async (r: number, c: number) => {
    if (!game || !playerId || game.turn !== playerId || game.status !== 'playing') return;
    
    const myAttacks = playerId === 1 ? game.p1Attacks : game.p2Attacks;
    const enemyShips = [...(playerId === 1 ? game.p2Ships : game.p1Ships)];

    if (myAttacks.find(a => a.r === r && a.c === c)) return;

    const hitShip = enemyShips.find(s => s.coords.some(sc => sc.r === r && sc.c === c));
    const isHit = !!hitShip;
    const newAttacks = [...myAttacks, { r, c, status: isHit ? 'hit' : 'miss' as CellStatus }];

    if (hitShip) {
      const allPartsHit = hitShip.coords.every(sc => 
        newAttacks.some(na => na.r === sc.r && na.c === sc.c && na.status === 'hit')
      );
      if (allPartsHit) hitShip.sunk = true;
    }

    const hasWon = enemyShips.every(s => s.sunk);
    await updateDoc(doc(db, "games", gameId), {
      [playerId === 1 ? 'p1Attacks' : 'p2Attacks']: newAttacks,
      [playerId === 1 ? 'p2Ships' : 'p1Ships']: enemyShips,
      turn: isHit ? playerId : (playerId === 1 ? 2 : 1),
      status: hasWon ? 'gameOver' : 'playing',
      winner: hasWon ? playerId : null,
      lastUpdated: serverTimestamp()
    });
  };

  // 6. DELETION / CLEANUP
  const handleManualDelete = async () => {
    if (window.confirm("WARNING: This will delete the room for ALL players. Proceed?")) {
      await deleteDoc(doc(db, "games", gameId));
      window.location.reload();
    }
  };

  if (!gameId) return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-white font-mono">
      <div className="bg-slate-900 p-10 border-2 border-cyan-500 rounded-2xl shadow-[0_0_50px_rgba(6,182,212,0.15)]">
        <h1 className="text-4xl font-black mb-8 text-cyan-400 italic uppercase tracking-tighter">Fleet Command</h1>
        <input className="w-full bg-black border border-slate-700 p-4 mb-6 rounded text-cyan-400 outline-none focus:border-cyan-400" placeholder="ENTER ROOM ID" onChange={e => setRoomInput(e.target.value)} />
        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => joinGame(roomInput, 1)} className="bg-cyan-600 p-4 rounded font-bold hover:bg-cyan-500">P1 JOIN</button>
          <button onClick={() => joinGame(roomInput, 2)} className="bg-emerald-600 p-4 rounded font-bold hover:bg-emerald-500">P2 JOIN</button>
        </div>
      </div>
    </div>
  );

  // const opponentReady = playerId === 1 ? game?.p2Ships.length === 5 : game?.p1Ships.length === 5;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono">
      <header className="max-w-5xl mx-auto flex justify-between items-center border-b border-slate-800 pb-4 mb-8">
        <div className="text-xs">
          <h2 className="text-cyan-500 font-bold uppercase tracking-widest">TERMINAL: {gameId} // P0{playerId}</h2>
          <p className="text-slate-500">STATUS: {game?.status?.toUpperCase()}</p>
        </div>

        {game?.status === 'playing' && (
          <div className={`px-4 py-1 border-2 text-xs font-bold ${game.turn === playerId ? 'text-green-400 border-green-400 animate-pulse' : 'text-red-900 border-red-900'}`}>
            {game.turn === playerId ? ">> YOUR TURN" : ">> ENEMY TURN"}
          </div>
        )}

        <button 
          onClick={handleManualDelete}
          className="text-[10px] text-red-500 border border-red-500/30 px-2 py-1 hover:bg-red-500 hover:text-white transition-all uppercase font-bold"
        >
          End Game
        </button>
      </header>

      <main className="max-w-6xl mx-auto flex flex-col items-center">
        {game?.status === 'placement' && (
          <div className="flex flex-col items-center gap-6 animate-in fade-in duration-500">
            <div className="text-center">
              <h3 className="text-2xl text-yellow-500 font-black italic">DEPLOYMENT: {SHIPS_CONFIG[placedShips.length]?.name || 'COMPLETE'}</h3>
              <p className="text-slate-500 text-xs mt-2 uppercase tracking-widest">R to Rotate | Click to Place</p>
            </div>
            <Grid 
              ships={placedShips}
              preview={hoverPos && placedShips.length < 5 ? getAdjustedCoords(hoverPos.r, hoverPos.c, SHIPS_CONFIG[placedShips.length].length, orientation) : []}
              onCellEnter={(r: number, c: number) => setHoverPos({ r, c })}
              onCellClick={handlePlaceShip}
            />
            {!isReady ? (
              <button disabled={placedShips.length < 5} onClick={submitShips} className="bg-white text-black px-12 py-3 font-black rounded-full hover:bg-cyan-400 disabled:opacity-20 transition-all">LOCK IN POSITIONS</button>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="text-cyan-500 animate-pulse font-bold tracking-[0.2em]">WAITING FOR ENEMY...</p>
              </div>
            )}
          </div>
        )}

        {game?.status === 'playing' && (
          <div className="grid lg:grid-cols-2 gap-16 w-full animate-in slide-in-from-bottom-10">
            <div className="flex flex-col items-center">
              <h3 className="text-[10px] text-slate-500 mb-4 tracking-[0.4em] uppercase">Your Fleet</h3>
              <Grid ships={playerId === 1 ? game.p1Ships : game.p2Ships} attacks={playerId === 1 ? game.p2Attacks : game.p1Attacks} />
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {(playerId === 1 ? game.p1Ships : game.p2Ships).map(s => <ShipBadge key={s.name} ship={s} />)}
              </div>
            </div>
            <div className="flex flex-col items-center">
              <h3 className="text-[10px] text-red-600 mb-4 tracking-[0.4em] uppercase font-bold">Targeting Array</h3>
              <Grid attacks={playerId === 1 ? game.p1Attacks : game.p2Attacks} onCellClick={handleAttack} isEnemyRadar enemyShips={playerId === 1 ? game.p2Ships : game.p1Ships} />
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {(playerId === 1 ? game.p2Ships : game.p1Ships).map(s => <ShipBadge key={s.name} ship={s} />)}
              </div>
            </div>
          </div>
        )}

        {game?.status === 'gameOver' && (
          <div className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center z-50 text-center">
            <h1 className={`text-9xl font-black italic tracking-tighter ${game.winner === playerId ? 'text-cyan-500' : 'text-red-600'}`}>
              {game.winner === playerId ? 'VICTORY' : 'DEFEAT'}
            </h1>
            <p className="text-slate-500 tracking-[1em] mb-12 uppercase">Mission Terminated</p>
            <button onClick={handleManualDelete} className="bg-white text-black px-16 py-4 font-black hover:bg-cyan-500 transition-all uppercase">Reboot System</button>
          </div>
        )}
      </main>
    </div>
  );
}

// --- HELPERS ---
function ShipBadge({ ship }: { ship: ShipInstance }) {
  return (
    <div className={`px-2 py-1 border text-[9px] font-bold transition-colors ${
      ship.sunk ? 'bg-red-950/40 border-red-500 text-red-500 line-through' : 'border-slate-700 text-slate-500'
    }`}>
      {ship.name.toUpperCase()}
    </div>
  );
}

function Grid({ ships = [], attacks = [], preview = [], onCellClick, onCellEnter, isEnemyRadar, enemyShips = [] }: any) {
  return (
    <div className="grid grid-cols-10 gap-1 bg-slate-900 p-1 border-4 border-slate-800" onMouseLeave={() => onCellEnter?.(null, null)}>
      {Array.from({ length: 100 }).map((_, i) => {
        const r = Math.floor(i / 10), c = i % 10;
        const ship = ships.find((s: any) => s.coords.some((sc: any) => sc.r === r && sc.c === c));
        const attack = attacks.find((a: any) => a.r === r && a.c === c);
        const isPreview = preview.some((p: any) => p.r === r && p.c === c);
        const sunkEnemyShip = enemyShips.find((s: any) => s.sunk && s.coords.some((sc: any) => sc.r === r && sc.c === c));

        let bgColor = "bg-slate-950", border = "border-transparent";
        if (isPreview) bgColor = "bg-cyan-400/20";
        if (ship) {
          bgColor = ship.sunk ? "bg-red-900/40" : "bg-cyan-800/40";
          border = ship.sunk ? "border-red-600" : "border-cyan-500/50";
        }
        if (isEnemyRadar && sunkEnemyShip) {
          bgColor = "bg-red-900/60";
          border = "border-red-600";
        }
        if (attack?.status === 'miss') bgColor = "bg-slate-800 opacity-20";
        if (attack?.status === 'hit') {
          const belongsToSunk = (isEnemyRadar ? enemyShips : ships).find((s: any) => s.sunk && s.coords.some((sc: any) => sc.r === r && sc.c === c));
          bgColor = belongsToSunk ? "bg-red-900" : "bg-red-500 animate-pulse";
        }

        return (
          <button key={i} onMouseEnter={() => onCellEnter?.(r, c)} onClick={() => onCellClick?.(r, c)}
            className={`w-7 h-7 sm:w-10 sm:h-10 border transition-all flex items-center justify-center text-[10px] ${bgColor} ${border}`}
          >
            {attack?.status === 'hit' && !sunkEnemyShip && "×"}
            {attack?.status === 'miss' && "·"}
          </button>
        );
      })}
    </div>
  );
}