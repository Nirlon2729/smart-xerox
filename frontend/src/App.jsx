import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { PrintSessionProvider } from "./context/PrintSessionContext";
import Header from "./components/Header";
import Home from "./pages/Home";
import PrintSettings from "./pages/PrintSettings";
import OrderSuccess from "./pages/OrderSuccess";
import AdminDashboard from "./pages/AdminDashboard";

export default function App() {
  return (
    <PrintSessionProvider>
      <BrowserRouter>
        <div className="min-h-screen flex flex-col bg-[#F7F6F3] text-[#18181B]">
          <Header />
          <main className="flex-1 w-full max-w-xl mx-auto px-4 pt-5">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/settings" element={<PrintSettings />} />
              <Route path="/job/:token" element={<OrderSuccess />} />
              <Route path="/order/:token" element={<OrderSuccess />} />
              <Route path="/admin" element={<AdminDashboard />} />
              <Route path="/owner" element={<AdminDashboard />} />
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
