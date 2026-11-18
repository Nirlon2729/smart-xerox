import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { PrintSessionProvider } from "./context/PrintSessionContext";
import Header from "./components/Header";
import LandingScanQr from "./pages/LandingScanQr";
import Home from "./pages/Home";
import PrintSettings from "./pages/PrintSettings";
import OrderSuccess from "./pages/OrderSuccess";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";

export default function App() {
  return (
    <PrintSessionProvider>
      <BrowserRouter>
        <div className="min-h-screen flex flex-col bg-[#F7F6F3] text-[#18181B]">
          <Header />
          <main className="flex-1 w-full max-w-xl mx-auto px-4 pt-5">
            <Routes>
              {/* Customer QR Landing & Shop-Specific Printing Workflow */}
              <Route path="/" element={<LandingScanQr />} />
              <Route path="/shop/:shopSlug" element={<Home />} />
              <Route path="/shop/:shopSlug/settings" element={<PrintSettings />} />
              <Route path="/shop/:shopSlug/job/:token" element={<OrderSuccess />} />
              <Route path="/shop/:shopSlug/order/:token" element={<OrderSuccess />} />

              {/* Platform-Level Super Admin Management */}
              <Route path="/super-admin" element={<SuperAdminDashboard />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>

        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3200,
            style: {
              borderRadius: "10px",
              background: "#18181B",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: 500,
              padding: "10px 14px"
            }
          }}
        />
      </BrowserRouter>
    </PrintSessionProvider>
  );
}
