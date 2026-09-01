import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { Landmark } from "lucide-react";
import OfflineBanner from "./components/OfflineBanner";
import Landing from "./features/landing/Landing";
import Join from "./features/join/Join";
import RoomScreen from "./features/room/RoomScreen";
import PhoneClient from "./features/room/PhoneClient";
import Dashboard from "./features/org/Dashboard";
import Billing from "./features/org/Billing";
import InstallHelp from "./features/install/InstallHelp";
import InstructorConsole from "./features/console/InstructorConsole";

/**
 * Application shell. Feature screens live under web/src/features/ and are
 * owned by the frontend build agents; this file only wires routing.
 */
export default function App() {
  return (
    <BrowserRouter>
      <OfflineBanner />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/join" element={<Join />} />
        <Route path="/install" element={<InstallHelp />} />
        <Route path="/session/:key" element={<RoomScreen />} />
        <Route path="/session/:key/phone" element={<PhoneClient />} />
        <Route path="/console/:key" element={<InstructorConsole />} />
        <Route path="/org/:orgId" element={<Dashboard />} />
        <Route path="/org/:orgId/billing" element={<Billing />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8">
      <Landmark className="h-10 w-10 text-brand" aria-hidden />
      <h1 className="text-3xl">Nothing here yet</h1>
      <p className="text-muted">The page you asked for does not exist.</p>
      <Link to="/" className="btn btn-primary">
        Back to Groundwork
      </Link>
    </div>
  );
}
