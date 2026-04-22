import './App.css'
import { useState, useEffect} from 'react';
import { db } from './firebase';
import { doc, onSnapshot, updateDoc, setDoc, getDoc } from 'firebase/firestore';

// --- TYPES ---
type CellStatus = 'water' | 'hit' | 'miss';

interface Coord {
  r: number;
  c: number;
}

interface Attack extends Coord {
  status: CellStatus;
}

interface GameState {
  p1Ships: Coord[];
  p2Ships: Coord[];
  p1Attacks: Attack[];
  p2Attacks: Attack[];
  turn: 1 | 2;
  status: 'placement' | 'playing' | 'gameOver';
  winner: number | null;
}

// --- CONSTANTS ---
const TOTAL_SHIP_CELLS = 17; // 5 + 4 + 3 + 3 + 2

export default function ShipBattleApp() {
  const [roomInput, setRoomInput] = useState("");
  const [gameId, setGameId] = useState("");
  const [playerId, setPlayerId] = useState<1 | 2 | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  
  // Local placement state
  const [myShips, setMyShips] = useState<Coord[]>([]);
  const [isReady, setIsReady] = useState(false);

  // 1. JOIN GAME LOGIC
  const joinGame = async (id: string, slot: 1 | 2) => {
    if (!id.trim()) return alert("Enter a Room ID");
    
    const docRef = doc(db, "games", id);
    const snap = await getDoc(docRef);

    if (!snap.exists()) {
      // Initialize a new game document
      await setDoc(docRef, {
        p1Ships: [],
        p2Ships: [],
        p1Attacks: [],
        p2Attacks: [],
        turn: 1,
        status: 'placement',
        winner: null
      });
    }

    setGameId(id);
    setPlayerId(slot);
  };

  // 2. REAL-TIME FIREBASE SYNC
  useEffect(() => {
    if (!gameId) return;

    const unsubscribe = onSnapshot(doc(db, "games", gameId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as GameState;
        setGame(data);
        
        // Auto-transition to playing if both have ships
        if (data.status === 'placement' && data.p1Ships.length === TOTAL_SHIP_CELLS && data.p2Ships.length === TOTAL_SHIP_CELLS) {
          updateDoc(doc(db, "games", gameId), { status: 'playing' });
        }
      }
    });

    return () => unsubscribe();
  }, [gameId]);

  // 3. PLACEMENT HANDLER
  const toggleShipPlacement = (r: number, c: number) => {
    if (isReady || game?.status !== 'placement') return;

    const exists = myShips.find(s => s.r === r && s.c === c);
    if (exists) {
      setMyShips(myShips.filter(s => !(s.r === r && s.c === c)));
    } else {
      if (myShips.length < TOTAL_SHIP_CELLS) {
        setMyShips([...myShips, { r, c }]);
      }
    }
  };

  const submitShips = async () => {
    if (myShips.length !== TOTAL_SHIP_CELLS) return alert(`Place all ${TOTAL_SHIP_CELLS} ship cells!`);
    setIsReady(true);
    const field = playerId === 1 ? 'p1Ships' : 'p2Ships';
    await updateDoc(doc(db, "games", gameId), { [field]: myShips });
  };

  // 4. ATTACK LOGIC (Turn Streak included)
  const handleAttack = async (r: number, c: number) => {
    if (!game || !playerId || game.turn !== playerId || game.status !== 'playing') return;

    const enemyId = playerId === 1 ? 2 : 1;
    const enemyShips = enemyId === 1 ? game.p1Ships : game.p2Ships;
    const myAttacks = playerId === 1 ? game.p1Attacks : game.p2Attacks;

    // Check if already attacked
    if (myAttacks.find(a => a.r === r && a.c === c)) return;

    const isHit = enemyShips.some(s => s.r === r && s.c === c);
    const newAttack: Attack = { r, c, status: isHit ? 'hit' : 'miss' };
    const updatedAttacks = [...myAttacks, newAttack];

    // RULE: If hit, turn stays the same. If miss, switch turn.
    const nextTurn = isHit ? playerId : (playerId === 1 ? 2 : 1);
    
    // Check Win Condition
    const hitsCount = updatedAttacks.filter(a => a.status === 'hit').length;
    const hasWon = hitsCount === TOTAL_SHIP_CELLS;

    await updateDoc(doc(db, "games", gameId), {
      [playerId === 1 ? 'p1Attacks' : 'p2Attacks']: updatedAttacks,
      turn: nextTurn,
      status: hasWon ? 'gameOver' : 'playing',
      winner: hasWon ? playerId : null
    });
  };

  // --- RENDERING SCREENS ---

  if (!gameId) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-white font-mono">
        <div className="bg-slate-900 p-8 border-2 border-cyan-500 shadow-[0_0_30px_rgba(6,182,212,0.2)] rounded-xl max-w-md w-full">
          <h1 className="text-4xl font-black italic text-cyan-500 mb-2 tracking-tighter">FLEET RADAR</h1>
          <p className="text-slate-500 text-xs mb-8 uppercase tracking-widest">Multi-Terminal Duel Protocol</p>
          
          <input 
            type="text"
            placeholder="ENTER ROOM ID"
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value.toLowerCase())}
            className="w-full bg-black border border-slate-700 p-3 mb-6 rounded text-cyan-400 focus:border-cyan-500 outline-none"
          />

          <div className="grid grid-cols-2 gap-4">
            <button onClick={() => joinGame(roomInput, 1)} className="bg-cyan-600 hover:bg-cyan-500 font-bold p-3 rounded transition-all">JOIN AS P1</button>
            <button onClick={() => joinGame(roomInput, 2)} className="bg-emerald-600 hover:bg-emerald-500 font-bold p-3 rounded transition-all">JOIN AS P2</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 font-mono">
      {/* HUD */}
      <header className="flex justify-between items-center max-w-6xl mx-auto mb-8 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-cyan-500 font-bold">OPERATIONAL LOG: {gameId.toUpperCase()}</h2>
          <p className="text-xs text-slate-500">ID: TERMINAL_0{playerId}</p>
        </div>
        {game?.status === 'playing' && (
          <div className={`px-4 py-1 border-2 font-black ${game.turn === playerId ? 'border-green-500 text-green-500 animate-pulse' : 'border-red-900 text-red-900'}`}>
            {game.turn === playerId ? ">> YOUR TURN" : ">> ENEMY TURN"}
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto">
        {/* PLACEMENT SCREEN */}
        {game?.status === 'placement' && (
          <div className="flex flex-col items-center gap-8">
            <div className="text-center">
              <h3 className="text-2xl font-black text-yellow-500 uppercase tracking-widest">Setup Phase</h3>
              <p className="text-slate-400">Select {TOTAL_SHIP_CELLS} cells to deploy your fleet: <span className="text-white font-bold">{myShips.length}/{TOTAL_SHIP_CELLS}</span></p>
            </div>
            
            <InteractiveGrid 
              activeCells={myShips.map(s => ({ ...s, type: 'ship' }))} 
              onCellClick={toggleShipPlacement} 
            />

            {!isReady ? (
              <button 
                disabled={myShips.length !== TOTAL_SHIP_CELLS}
                onClick={submitShips}
                className="bg-white text-black font-black px-12 py-3 rounded-full disabled:opacity-30 hover:bg-cyan-500 transition-all"
              >
                CONFIRM DEPLOYMENT
              </button>
            ) : (
              <p className="text-cyan-400 animate-pulse font-bold tracking-widest">WAITING FOR ENEMY DEPLOYMENT...</p>
            )}
          </div>
        )}

        {/* BATTLE SCREEN */}
        {game?.status === 'playing' && (
          <div className="grid lg:grid-cols-2 gap-12">
            {/* Friendly Waters (My Ships + Enemy Shots) */}
            <div className="flex flex-col items-center">
              <h3 className="text-xs text-slate-500 uppercase mb-4 tracking-[0.3em]">Friendly Fleet</h3>
              <InteractiveGrid 
                activeCells={[
                  ...myShips.map(s => ({ ...s, type: 'ship' as const })),
                  ...(playerId === 1 ? game.p2Attacks : game.p1Attacks).map(a => ({ ...a, type: a.status as any }))
                ]} 
              />
            </div>

            {/* Enemy Waters (My Shots) */}
            <div className="flex flex-col items-center">
              <h3 className="text-xs text-red-500 uppercase mb-4 tracking-[0.3em]">Target Radar</h3>
              <InteractiveGrid 
                onCellClick={(r, c) => handleAttack(r, c)}
                activeCells={(playerId === 1 ? game.p1Attacks : game.p2Attacks).map(a => ({ ...a, type: a.status as any }))} 
              />
            </div>
          </div>
        )}

        {/* GAME OVER SCREEN */}
        {game?.status === 'gameOver' && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center z-50">
            <h1 className={`text-8xl font-black italic ${game.winner === playerId ? 'text-cyan-500' : 'text-red-600'}`}>
              {game.winner === playerId ? 'VICTORY' : 'DEFEAT'}
            </h1>
            <p className="text-slate-500 mt-4 tracking-[1em] uppercase">Combat Log Closed</p>
            <button onClick={() => window.location.reload()} className="mt-12 border border-white px-8 py-2 hover:bg-white hover:text-black transition-all">RESTART TERMINAL</button>
          </div>
        )}
      </main>
    </div>
  );
}

// --- REUSABLE GRID UI ---

function InteractiveGrid({ activeCells, onCellClick }: { 
  activeCells: (Coord & { type: 'ship' | 'hit' | 'miss' })[], 
  onCellClick?: (r: number, c: number) => void 
}) {
  return (
    <div className="grid grid-cols-10 gap-1 bg-slate-900 p-1 border-2 border-slate-800 shadow-2xl">
      {Array.from({ length: 100 }).map((_, i) => {
        const r = Math.floor(i / 10);
        const c = i % 10;
        const cell = activeCells.find(a => a.r === r && a.c === c);

        let color = "bg-slate-950";
        if (cell?.type === 'ship') color = "bg-cyan-900 border border-cyan-700";
        if (cell?.type === 'hit') color = "bg-red-600 animate-pulse shadow-[0_0_15px_rgba(220,38,38,0.5)]";
        if (cell?.type === 'miss') color = "bg-slate-700 opacity-40";

        return (
          <button
            key={i}
            disabled={!onCellClick || cell?.type === 'hit' || cell?.type === 'miss'}
            onClick={() => onCellClick?.(r, c)}
            className={`w-8 h-8 sm:w-10 sm:h-10 transition-all flex items-center justify-center text-xs ${color} ${onCellClick ? 'hover:bg-slate-800' : ''}`}
          >
            {cell?.type === 'hit' && "💥"}
            {cell?.type === 'miss' && "•"}
          </button>
        );
      })}
    </div>
  );
}