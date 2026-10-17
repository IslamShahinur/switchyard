import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { LiveProvider } from "@/lib/live";
import { Shell } from "@/components/shell";
import Overview from "@/pages/overview";
import Approvals from "@/pages/approvals";
import ProjectPage from "@/pages/project";
import Diagnostics from "@/pages/diagnostics";
import Schedules from "@/pages/schedules";
import Settings from "@/pages/settings";

function AppRouter() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/approvals" component={Approvals} />
        <Route path="/approvals/:id" component={Approvals} />
        <Route path="/p/:id" component={ProjectPage} />
        <Route path="/diagnostics" component={Diagnostics} />
        <Route path="/schedules" component={Schedules} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LiveProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </LiveProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
