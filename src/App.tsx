import './App.css'
import { useState, useEffect, useCallback, useRef } from 'react';
import { db } from './firebase';
import { 
  doc, onSnapshot, updateDoc, setDoc, getDoc, serverTimestamp, Timestamp, arrayUnion 
} from 'firebase/firestore';

// --- CONFIG ---
const GRID_SIZE = 10;
const SHIPS_CONFIG = [
  { name: 'Supercarrier', length: 5 },
  { name: 'Dreadnought', length: 4 },
  { name: 'Aegis Cruiser', length: 3 },
  { name: 'Phantom Sub', length: 3 },
  { name: 'Vanguard Stalker', length: 2 },
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
interface ChatMessage {
  sender: number;
  text: string;
  timestamp: number;
}

interface GameState {
  p1Ships: ShipInstance[];
  p2Ships: ShipInstance[];
  p1Attacks: Attack[];
  p2Attacks: Attack[];
  turn: 1 | 2;
  status: 'placement' | 'playing' | 'gameOver' | 'aborted';
  winner: number | null;
  lastUpdated: Timestamp;
  messages: ChatMessage[];
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
  const [chatMsg, setChatMsg] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [game?.messages]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r') setOrientation(prev => (prev === 'H' ? 'V' : 'H'));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // JOIN LOGIC
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
          messages: [],
          lastUpdated: serverTimestamp()
        });
      };

      if (snap.exists()) {
        const data = snap.data() as GameState;
        const lastMillis = data.lastUpdated?.toMillis() || 0;
        // RESET: If game is old or finished, start a fresh one
        if (data.status === 'gameOver' || data.status === 'aborted' || Date.now() - lastMillis > 15 * 60 * 1000) {
          await initializeRoom();
        }
      } else {
        await initializeRoom();
      }
      setGameId(cleanId);
      setPlayerId(slot);
    } catch (e) { alert("Firebase Error."); }
  };

  // REAL-TIME SYNC + GAME START LOGIC
  useEffect(() => {
    if (!gameId) return;
    const unsub = onSnapshot(doc(db, "games", gameId), (s) => {
      if (s.exists()) {
        const data = s.data() as GameState;
        setGame(data);
        
        // THIS IS THE FIX: Automatically start game when both players have 5 ships
        if (data.status === 'placement' && data.p1Ships?.length === 5 && data.p2Ships?.length === 5) {
          updateDoc(doc(db, "games", gameId), { status: 'playing', lastUpdated: serverTimestamp() });
        }
      } else {
        setGameId("");
      }
    });
    return () => unsub();
  }, [gameId]);

  const sendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatMsg.trim() || !gameId || !playerId) return;
    await updateDoc(doc(db, "games", gameId), {
      messages: arrayUnion({ sender: playerId, text: chatMsg.trim(), timestamp: Date.now() })
    });
    setChatMsg("");
  };

  const handleAttack = async (r: number, c: number) => {
    if (!game || !playerId || game.turn !== playerId || game.status !== 'playing') return;
    const myAttacks = playerId === 1 ? game.p1Attacks : game.p2Attacks;
    const enemyShips = [...(playerId === 1 ? game.p2Ships : game.p1Ships)];
    if (myAttacks.find(a => a.r === r && a.c === c)) return;

    const hitShip = enemyShips.find(s => s.coords.some(sc => sc.r === r && sc.c === c));
    const isHit = !!hitShip;
    const newAttacks = [...myAttacks, { r, c, status: isHit ? 'hit' : 'miss' as CellStatus }];

    if (hitShip) {
      const allPartsHit = hitShip.coords.every(sc => newAttacks.some(na => na.r === sc.r && na.c === sc.c && na.status === 'hit'));
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

  const handleAbort = async () => {
    if (window.confirm("Abandon current mission? This reveals your fleet to the enemy.")) {
      await updateDoc(doc(db, "games", gameId), { 
        status: 'aborted',
        messages: arrayUnion({ sender: playerId, text: ">> OP_ABORTED: COMMANDER DISCONNECTED", timestamp: Date.now() })
      });
    }
  };

  const goHome = () => {
    setGameId("");
    setPlayerId(null);
    setGame(null);
    setPlacedShips([]);
    setIsReady(false);
    setRoomInput("");
  };

  const handlePlaceShip = () => {
    if (!hoverPos || placedShips.length >= 5) return;
    const currentConfig = SHIPS_CONFIG[placedShips.length];
    const coords = getAdjustedCoords(hoverPos.r, hoverPos.c, currentConfig.length, orientation);
    const overlap = coords.some(c => placedShips.flatMap(s => s.coords).some(ec => ec.r === c.r && ec.c === c.c));
    if (overlap) return;
    setPlacedShips([...placedShips, { name: currentConfig.name, coords, sunk: false }]);
  };

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

  const submitShips = async () => {
    setIsReady(true);
    const field = playerId === 1 ? 'p1Ships' : 'p2Ships';
    await updateDoc(doc(db, "games", gameId), { [field]: placedShips, lastUpdated: serverTimestamp() });
  };

  if (!gameId) return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-white font-mono p-4">
      <div className="max-w-xl w-full bg-slate-900 p-8 border-2 border-cyan-500 rounded-2xl shadow-[0_0_50px_rgba(6,182,212,0.2)]">
        <h1 className="text-4xl font-black mb-2 text-cyan-400 italic uppercase tracking-tighter text-center">Fleet Command</h1>
        <p className="text-center text-slate-500 text-[10px] mb-8 tracking-[0.4em]">TACTICAL BATTLE INTERFACE</p>
        
        <div className="mb-8 space-y-4 bg-black/40 p-4 border border-slate-800 rounded-lg">
          <h3 className="text-cyan-500 text-xs font-bold uppercase tracking-widest border-b border-slate-800 pb-2">Tactical Briefing</h3>
          <ul className="text-[11px] space-y-2 text-slate-400">
            <li><span className="text-cyan-500 font-bold">01</span> DEPLOY 5 VESSELS. USE <span className="text-white font-bold">[R]</span> TO ROTATE.</li>
            <li><span className="text-cyan-500 font-bold">02</span> <span className="text-emerald-400 font-bold">HITS</span> GRANT EXTRA TURNS.</li>
            <li><span className="text-cyan-500 font-bold">03</span> <span className="text-red-500 font-bold">MISSES</span> END YOUR TURN.</li>
          </ul>
        </div>

        <input 
          className="w-full bg-black border border-slate-700 p-4 mb-6 rounded text-cyan-400 outline-none focus:border-cyan-500 transition-colors uppercase text-sm tracking-widest" 
          placeholder="Enter Room Code" 
          value={roomInput}
          onChange={e => setRoomInput(e.target.value)} 
        />
        
        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => joinGame(roomInput, 1)} className="bg-cyan-600 p-4 rounded font-bold hover:bg-cyan-500 transition-all uppercase text-xs active:scale-95">Join P1</button>
          <button onClick={() => joinGame(roomInput, 2)} className="bg-emerald-600 p-4 rounded font-bold hover:bg-emerald-500 transition-all uppercase text-xs active:scale-95">Join P2</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono flex flex-col">
      {/* HUD OVERLAY - Results Display */}
      {(game?.status === 'gameOver' || game?.status === 'aborted') && (
        <div className="fixed top-0 left-0 w-full z-100 flex justify-center p-4 pointer-events-none">
          <div className="bg-black border-2 border-cyan-500 p-4 px-12 shadow-[0_0_50px_rgba(0,0,0,1)] text-center pointer-events-auto flex flex-col items-center animate-in slide-in-from-top duration-500">
            {game.status === 'gameOver' ? (
              <h1 className={`text-5xl font-black italic tracking-tighter ${game.winner === playerId ? 'text-cyan-500' : 'text-red-600'}`}>
                {game.winner === playerId ? 'VICTORY ACHIEVED' : 'DEFEAT SUFFERED'}
              </h1>
            ) : (
              <h1 className="text-4xl font-black text-red-500 italic tracking-tighter uppercase">Command Severed</h1>
            )}
            <p className="text-[10px] text-slate-400 uppercase tracking-[0.3em] mt-1">Enemy fleet positions unmasked on radar</p>
            <button onClick={goHome} className="mt-4 bg-white text-black px-10 py-1 font-black hover:bg-cyan-500 transition-all text-[10px] uppercase tracking-widest">Return Home</button>
          </div>
        </div>
      )}

      <header className={`max-w-6xl mx-auto w-full flex justify-between items-center border-b border-slate-800 pb-4 mb-6 transition-opacity ${game?.status !== 'playing' ? 'opacity-20' : ''}`}>
        <div>
          <h2 className="text-cyan-500 font-bold uppercase tracking-widest text-xs">LINK: {gameId} // CMD_0{playerId}</h2>
          <p className="text-[10px] text-slate-500 uppercase">{game?.status === 'playing' ? 'Combat Active' : 'Fleet Positioning'}</p>
        </div>
        {game?.status === 'playing' && (
          <div className={`px-6 py-1 border-2 text-xs font-black transition-all ${game.turn === playerId ? 'text-green-400 border-green-400 animate-pulse' : 'text-slate-800 border-slate-900'}`}>
            {game.turn === playerId ? ">> YOUR TURN" : ">> ENEMY TURN"}
          </div>
        )}
        <button onClick={handleAbort} className="text-[10px] text-red-500 border border-red-500/30 px-3 py-1 hover:bg-red-500 hover:text-white transition-all font-bold uppercase">Abort</button>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full flex flex-col items-center justify-center relative">
        {game?.status === 'placement' && (
          <div className="flex flex-col items-center gap-8 animate-in fade-in duration-500">
            <div className="text-center">
              <h3 className="text-3xl text-yellow-500 font-black italic uppercase">{SHIPS_CONFIG[placedShips.length]?.name || 'FLEET DEPLOYED'}</h3>
              <p className="text-slate-500 text-[10px] mt-2 uppercase tracking-[0.3em]">Press 'R' to Rotate | Click to position</p>
            </div>
            <Grid 
              ships={placedShips}
              preview={hoverPos && placedShips.length < 5 ? getAdjustedCoords(hoverPos.r, hoverPos.c, SHIPS_CONFIG[placedShips.length].length, orientation) : []}
              onCellEnter={(r: number, c: number) => setHoverPos({ r, c })}
              onCellClick={handlePlaceShip}
            />
            {!isReady ? (
              <button disabled={placedShips.length < 5} onClick={submitShips} className="bg-white text-black px-16 py-4 font-black rounded-full hover:bg-cyan-400 disabled:opacity-20 transition-all uppercase tracking-widest">Confirm Positions</button>
            ) : (
              <div className="text-cyan-500 animate-pulse font-bold border border-cyan-500/20 px-8 py-3 uppercase text-sm tracking-widest">Waiting for Enemy...</div>
            )}
          </div>
        )}

        {(game?.status === 'playing' || game?.status === 'gameOver' || game?.status === 'aborted') && (
          <div className="grid lg:grid-cols-2 gap-16 w-full items-center">
            <div className={`flex flex-col items-center transition-all duration-700 ${game?.status !== 'playing' ? 'scale-90 opacity-60' : ''}`}>
              <h3 className="text-[10px] text-slate-500 mb-4 tracking-[0.4em] uppercase">Tactical Defense Matrix</h3>
              <Grid ships={playerId === 1 ? game.p1Ships : game.p2Ships} attacks={playerId === 1 ? game.p2Attacks : game.p1Attacks} />
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {(playerId === 1 ? game.p1Ships : game.p2Ships).map(s => <ShipBadge key={s.name} ship={s} />)}
              </div>
            </div>
            <div className="flex flex-col items-center">
              <h3 className={`text-[10px] mb-4 tracking-[0.4em] uppercase font-bold ${game?.status !== 'playing' ? 'text-yellow-500 animate-pulse' : 'text-red-600'}`}>
                {game?.status !== 'playing' ? '>> ENEMY POSITIONS REVEALED <<' : 'Orbital Strike Radar'}
              </h3>
              <Grid 
                attacks={playerId === 1 ? game.p1Attacks : game.p2Attacks} 
                onCellClick={handleAttack} 
                isEnemyRadar 
                enemyShips={playerId === 1 ? game.p2Ships : game.p1Ships} 
                showReveal={game?.status === 'gameOver' || game?.status === 'aborted'}
              />
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {(playerId === 1 ? game.p2Ships : game.p1Ships).map(s => <ShipBadge key={s.name} ship={s} />)}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* VALORANT CHAT */}
      {gameId && (
        <div className="fixed bottom-6 left-6 w-80 z-40 flex flex-col pointer-events-none">
          <div className="flex-1 max-h-48 overflow-y-auto flex flex-col p-2 pointer-events-none bg-linear-to-t from-black/40 to-transparent">
            {game?.messages?.map((msg, idx) => (
              <div key={idx} className="flex gap-2 items-baseline mb-1 animate-in fade-in slide-in-from-left-2 duration-300">
                <span className={`text-[10px] font-black uppercase whitespace-nowrap drop-shadow-md ${
                  msg.sender === 1 ? 'text-cyan-400' : 'text-emerald-400'
                }`}>[CMD_0{msg.sender}]:</span>
                <span className="text-white text-[12px] font-medium drop-shadow-lg leading-tight wrap-break-words">{msg.text}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={sendChatMessage} className="pointer-events-auto mt-2 flex items-center bg-black/40 backdrop-blur-md border border-white/10 rounded-sm px-3 py-2 focus-within:border-cyan-500/50 transition-all group">
            <input 
              value={chatMsg}
              onChange={e => setChatMsg(e.target.value)}
              placeholder="ENTER TO MESSAGE..."
              className="flex-1 bg-transparent text-[11px] outline-none text-white placeholder:text-slate-600 uppercase tracking-wider"
            />
            <div className="text-[9px] text-slate-600 group-focus-within:text-cyan-500 font-bold transition-colors uppercase cursor-default">Send</div>
          </form>
        </div>
      )}
    </div>
  );
}

// --- SUB-COMPONENTS ---

function ShipBadge({ ship }: { ship: ShipInstance }) {
  return (
    <div className={`px-2 py-1 border text-[9px] font-bold transition-colors ${
      ship.sunk ? 'bg-red-950/40 border-red-500 text-red-500 line-through' : 'border-slate-800 text-slate-600'
    }`}>
      {ship.name.toUpperCase()}
    </div>
  );
}

function Grid({ ships = [], attacks = [], preview = [], onCellClick, onCellEnter, isEnemyRadar, enemyShips = [], showReveal }: any) {
  return (
    <div className="grid grid-cols-10 gap-1 bg-slate-900 p-1 border-4 border-slate-800 shadow-2xl" onMouseLeave={() => onCellEnter?.(null, null)}>
      {Array.from({ length: 100 }).map((_, i) => {
        const r = Math.floor(i / 10), c = i % 10;
        const shipOnCell = ships.find((s: any) => s.coords.some((sc: any) => sc.r === r && sc.c === c));
        const enemyShipOnCell = enemyShips.find((s: any) => s.coords.some((sc: any) => sc.r === r && sc.c === c));
        const attack = attacks.find((a: any) => a.r === r && a.c === c);
        const isPreview = preview.some((p: any) => p.r === r && p.c === c);
        
        let bgColor = "bg-slate-950", border = "border-transparent", content = "";
        if (isPreview) bgColor = "bg-cyan-400/20";
        if (shipOnCell) {
          bgColor = shipOnCell.sunk ? "bg-red-900/40" : "bg-cyan-800/40";
          border = shipOnCell.sunk ? "border-red-600" : "border-cyan-500/50";
        }
        if (isEnemyRadar) {
          if (enemyShipOnCell?.sunk) {
            bgColor = "bg-red-900/60";
            border = "border-red-600";
          } else if (showReveal && enemyShipOnCell) {
            bgColor = "bg-cyan-500/30";
            border = "border-cyan-400";
          }
        }
        if (attack?.status === 'miss') {
          bgColor = "bg-slate-800/30";
          content = "·";
        }
        if (attack?.status === 'hit') {
          const belongsToSunk = (isEnemyRadar ? enemyShips : ships).find((s: any) => s.sunk && s.coords.some((sc: any) => sc.r === r && sc.c === c));
          bgColor = belongsToSunk ? "bg-red-900" : "bg-red-500 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.4)]";
          content = "×";
        }

        return (
          <button key={i} onMouseEnter={() => onCellEnter?.(r, c)} onClick={() => onCellClick?.(r, c)}
            className={`w-7 h-7 sm:w-11 sm:h-11 border transition-all flex items-center justify-center text-xs font-bold ${bgColor} ${border}`}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}