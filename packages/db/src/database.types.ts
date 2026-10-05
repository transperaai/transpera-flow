export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_analyses: {
        Row: {
          checked: number
          created_at: string
          created_by: string
          dropped: number
          id: string
          input_hash: string
          insights: Json
          model: string | null
          process_id: string
          reason: string | null
          review: Json
          revision_id: string
          run_id: string
          status: string
          summary: Json
          trigger: string
          updated_at: string
          usage: Json
          workspace_id: string
        }
        Insert: {
          checked?: number
          created_at?: string
          created_by?: string
          dropped?: number
          id?: string
          input_hash: string
          insights?: Json
          model?: string | null
          process_id: string
          reason?: string | null
          review?: Json
          revision_id: string
          run_id: string
          status: string
          summary?: Json
          trigger: string
          updated_at?: string
          usage?: Json
          workspace_id: string
        }
        Update: {
          checked?: number
          created_at?: string
          created_by?: string
          dropped?: number
          id?: string
          input_hash?: string
          insights?: Json
          model?: string | null
          process_id?: string
          reason?: string | null
          review?: Json
          revision_id?: string
          run_id?: string
          status?: string
          summary?: Json
          trigger?: string
          updated_at?: string
          usage?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_analyses_revision_id_process_id_workspace_id_fkey"
            columns: ["revision_id", "process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "process_id", "workspace_id"]
          },
          {
            foreignKeyName: "ai_analyses_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_analyses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_runs: {
        Row: {
          id: string
          process_id: string
          started_at: string
          trigger: string
          user_id: string | null
          user_name: string | null
          workspace_id: string
        }
        Insert: {
          id?: string
          process_id: string
          started_at?: string
          trigger: string
          user_id?: string | null
          user_name?: string | null
          workspace_id: string
        }
        Update: {
          id?: string
          process_id?: string
          started_at?: string
          trigger?: string
          user_id?: string | null
          user_name?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_runs_process_id_fkey"
            columns: ["process_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_settings: {
        Row: {
          created_at: string
          created_by: string | null
          market_pending_at: string | null
          read_sources: boolean
          review_on_market: boolean
          review_on_publish: boolean
          suggest_issues: boolean
          suggest_solutions: boolean
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          market_pending_at?: string | null
          read_sources?: boolean
          review_on_market?: boolean
          review_on_publish?: boolean
          suggest_issues?: boolean
          suggest_solutions?: boolean
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          market_pending_at?: string | null
          read_sources?: boolean
          review_on_market?: boolean
          review_on_publish?: boolean
          suggest_issues?: boolean
          suggest_solutions?: boolean
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      analysis_rules: {
        Row: {
          created_at: string
          created_by: string | null
          settings: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          settings?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          settings?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analysis_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          active_workspace_id: string | null
          created_at: string
          created_by: string | null
          id: string
          label: string
          last_used_at: string | null
          rate_window_count: number
          rate_window_start: string | null
          revoked_at: string | null
          token_hash: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_workspace_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          label: string
          last_used_at?: string | null
          rate_window_count?: number
          rate_window_start?: string | null
          revoked_at?: string | null
          token_hash: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          active_workspace_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          last_used_at?: string | null
          rate_window_count?: number
          rate_window_start?: string | null
          revoked_at?: string | null
          token_hash?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_active_workspace_id_fkey"
            columns: ["active_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          created_at: string
          diff: Json
          id: string
          target_id: string | null
          target_table: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind?: string
          created_at?: string
          diff?: Json
          id?: string
          target_id?: string | null
          target_table: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          created_at?: string
          diff?: Json
          id?: string
          target_id?: string | null
          target_table?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      churn_drivers: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          driver: string | null
          enabled: boolean
          example: string | null
          id: string
          month: number | null
          name: string | null
          provenance: Json
          updated_at: string
          value: number | null
          weight: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          driver?: string | null
          enabled?: boolean
          example?: string | null
          id?: string
          month?: number | null
          name?: string | null
          provenance?: Json
          updated_at?: string
          value?: number | null
          weight?: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          driver?: string | null
          enabled?: boolean
          example?: string | null
          id?: string
          month?: number | null
          name?: string | null
          provenance?: Json
          updated_at?: string
          value?: number | null
          weight?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "churn_drivers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      blocks: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          id: string
          name: string
          steps: Json
          type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          name: string
          steps: Json
          type?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          name?: string
          steps?: Json
          type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      client_assignments: {
        Row: {
          client_id: string
          created_at: string
          person_id: string
          role_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          person_id: string
          role_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          person_id?: string
          role_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_assignments_client_id_workspace_id_fkey"
            columns: ["client_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "client_assignments_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "client_assignments_role_id_workspace_id_fkey"
            columns: ["role_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      client_groups: {
        Row: {
          client_count: number
          churn_monthly: number
          created_at: string
          created_by: string | null
          fee: number
          id: string
          provenance: Json
          service_id: string
          starting_health: number
          stay_months: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_count?: number
          churn_monthly?: number
          created_at?: string
          created_by?: string | null
          fee?: number
          id?: string
          provenance?: Json
          service_id: string
          starting_health?: number
          stay_months?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_count?: number
          churn_monthly?: number
          created_at?: string
          created_by?: string | null
          fee?: number
          id?: string
          provenance?: Json
          service_id?: string
          starting_health?: number
          stay_months?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_groups_service_id_workspace_id_fkey"
            columns: ["service_id", "workspace_id"]
            isOneToOne: true
            referencedRelation: "services"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "client_groups_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      client_services: {
        Row: {
          client_id: string
          created_at: string
          service_id: string
          start_date: string | null
          workspace_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          service_id: string
          start_date?: string | null
          workspace_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          service_id?: string
          start_date?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_services_client_id_workspace_id_fkey"
            columns: ["client_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "client_services_service_id_workspace_id_fkey"
            columns: ["service_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      clients: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          health: number | null
          id: string
          mrr: number
          name: string
          notes: string | null
          provenance: Json
          start_date: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          health?: number | null
          id?: string
          mrr?: number
          name: string
          notes?: string | null
          provenance?: Json
          start_date?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          health?: number | null
          id?: string
          mrr?: number
          name?: string
          notes?: string | null
          provenance?: Json
          start_date?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_settings: {
        Row: {
          created_at: string
          created_by: string | null
          growth_monthly: number
          provenance: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          growth_monthly?: number
          provenance?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          growth_monthly?: number
          provenance?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "demand_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      edges: {
        Row: {
          condition_tag: string | null
          created_at: string
          created_by: string | null
          from_step_id: string
          id: string
          label: string | null
          probability: number
          process_id: string
          revision_id: string
          to_step_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          condition_tag?: string | null
          created_at?: string
          created_by?: string | null
          from_step_id: string
          id?: string
          label?: string | null
          probability?: number
          process_id: string
          revision_id: string
          to_step_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          condition_tag?: string | null
          created_at?: string
          created_by?: string | null
          from_step_id?: string
          id?: string
          label?: string | null
          probability?: number
          process_id?: string
          revision_id?: string
          to_step_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edges_revision_id_from_step_id_fkey"
            columns: ["revision_id", "from_step_id"]
            isOneToOne: false
            referencedRelation: "steps"
            referencedColumns: ["revision_id", "id"]
          },
          {
            foreignKeyName: "edges_revision_id_to_step_id_fkey"
            columns: ["revision_id", "to_step_id"]
            isOneToOne: false
            referencedRelation: "steps"
            referencedColumns: ["revision_id", "id"]
          },
          {
            foreignKeyName: "edges_revision_id_workspace_id_fkey"
            columns: ["revision_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      first_principles: {
        Row: {
          created_at: string
          created_by: string | null
          deletes: Json
          id: string
          improvements: Json
          job_done: string
          job_progress: string
          job_situation: string
          job_who: string
          measures: Json
          process_id: string
          requirements: Json
          revision_id: string
          root_cause: string
          statements: Json
          updated_at: string
          why_chain: Json
          why_problem: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deletes?: Json
          id?: string
          improvements?: Json
          job_done?: string
          job_progress?: string
          job_situation?: string
          job_who?: string
          measures?: Json
          process_id: string
          requirements?: Json
          revision_id: string
          root_cause?: string
          statements?: Json
          updated_at?: string
          why_chain?: Json
          why_problem?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deletes?: Json
          id?: string
          improvements?: Json
          job_done?: string
          job_progress?: string
          job_situation?: string
          job_who?: string
          measures?: Json
          process_id?: string
          requirements?: Json
          revision_id?: string
          root_cause?: string
          statements?: Json
          updated_at?: string
          why_chain?: Json
          why_problem?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "first_principles_revision_id_process_id_workspace_id_fkey"
            columns: ["revision_id", "process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "process_id", "workspace_id"]
          },
          {
            foreignKeyName: "first_principles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      issue_events: {
        Row: {
          actor: string | null
          at: string
          detail: Json
          id: string
          issue_id: string
          kind: string
          seq: number
          tx: number | null
          workspace_id: string
        }
        Insert: {
          actor?: string | null
          at?: string
          detail?: Json
          id?: string
          issue_id: string
          kind: string
          seq?: never
          tx?: number | null
          workspace_id: string
        }
        Update: {
          actor?: string | null
          at?: string
          detail?: Json
          id?: string
          issue_id?: string
          kind?: string
          seq?: never
          tx?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_events_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      issue_links: {
        Row: {
          created_at: string
          id: string
          issue_id: string
          process_id: string | null
          step_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          issue_id: string
          process_id?: string | null
          step_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          issue_id?: string
          process_id?: string | null
          step_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_links_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issue_links_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      issue_owners: {
        Row: {
          created_at: string
          issue_id: string
          person_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          issue_id: string
          person_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          issue_id?: string
          person_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_owners_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issue_owners_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      issue_sources: {
        Row: {
          created_at: string
          issue_id: string
          source_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          issue_id: string
          source_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          issue_id?: string
          source_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_sources_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issue_sources_source_id_workspace_id_fkey"
            columns: ["source_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      issues: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string | null
          detected_key: string | null
          dismissed_revision_id: string | null
          evidence: string | null
          evidence_metrics: Json
          evidence_sources: Json
          id: string
          number: number | null
          owner_person_id: string | null
          person_id: string | null
          process_id: string | null
          resolution: string | null
          resolution_note: string | null
          resolved_how: string | null
          resolved_solution_id: string | null
          resolved_at: string | null
          role_id: string | null
          scenario_id: string | null
          severity: string
          source: string
          status: string
          step_id: string | null
          target_goal: string | null
          target_measure: string | null
          target_now: string | null
          title: string
          type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          detected_key?: string | null
          dismissed_revision_id?: string | null
          evidence?: string | null
          evidence_metrics?: Json
          evidence_sources?: Json
          id?: string
          number?: number | null
          owner_person_id?: string | null
          person_id?: string | null
          process_id?: string | null
          resolution?: string | null
          resolution_note?: string | null
          resolved_how?: string | null
          resolved_solution_id?: string | null
          resolved_at?: string | null
          role_id?: string | null
          scenario_id?: string | null
          severity?: string
          source?: string
          status?: string
          step_id?: string | null
          target_goal?: string | null
          target_measure?: string | null
          target_now?: string | null
          title: string
          type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          detected_key?: string | null
          dismissed_revision_id?: string | null
          evidence?: string | null
          evidence_metrics?: Json
          evidence_sources?: Json
          id?: string
          number?: number | null
          owner_person_id?: string | null
          person_id?: string | null
          process_id?: string | null
          resolution?: string | null
          resolution_note?: string | null
          resolved_how?: string | null
          resolved_solution_id?: string | null
          resolved_at?: string | null
          role_id?: string | null
          scenario_id?: string | null
          severity?: string
          source?: string
          status?: string
          step_id?: string | null
          target_goal?: string | null
          target_measure?: string | null
          target_now?: string | null
          title?: string
          type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issues_client_id_workspace_id_fkey"
            columns: ["client_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_dismissed_revision_id_workspace_id_fkey"
            columns: ["dismissed_revision_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_owner_person_id_workspace_id_fkey"
            columns: ["owner_person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_role_id_workspace_id_fkey"
            columns: ["role_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_scenario_id_workspace_id_fkey"
            columns: ["scenario_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "issues_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_sources: {
        Row: {
          conversion_to_qualified: number
          created_at: string
          created_by: string | null
          id: string
          name: string
          provenance: Json
          updated_at: string
          volume_week: number
          workspace_id: string
        }
        Insert: {
          conversion_to_qualified?: number
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          provenance?: Json
          updated_at?: string
          volume_week?: number
          workspace_id: string
        }
        Update: {
          conversion_to_qualified?: number
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          provenance?: Json
          updated_at?: string
          volume_week?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lever_settings: {
        Row: {
          created_at: string
          created_by: string | null
          hidden: string[]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          hidden?: string[]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          hidden?: string[]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lever_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      market_conditions: {
        Row: {
          churn: number
          conv: number
          created_at: string
          created_by: string | null
          cycle: number
          hire: number
          id: string
          leads: number
          name: string
          pay: number
          preset: string | null
          price: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          churn?: number
          conv?: number
          created_at?: string
          created_by?: string | null
          cycle?: number
          hire?: number
          id?: string
          leads?: number
          name: string
          pay?: number
          preset?: string | null
          price?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          churn?: number
          conv?: number
          created_at?: string
          created_by?: string | null
          cycle?: number
          hire?: number
          id?: string
          leads?: number
          name?: string
          pay?: number
          preset?: string | null
          price?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_conditions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      market_schedule: {
        Row: {
          condition_id: string
          created_at: string
          created_by: string | null
          from_month: number
          id: string
          to_month: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          condition_id: string
          created_at?: string
          created_by?: string | null
          from_month: number
          id?: string
          to_month: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          condition_id?: string
          created_at?: string
          created_by?: string | null
          from_month?: number
          id?: string
          to_month?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_schedule_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "market_schedule_condition_id_workspace_id_fkey"
            columns: ["condition_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "market_conditions"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      memberships: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          person_id: string | null
          role: Database["public"]["Enums"]["membership_role"]
          source: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          person_id?: string | null
          role: Database["public"]["Enums"]["membership_role"]
          source?: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          person_id?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          source?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "memberships_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      narrations: {
        Row: {
          checked: number
          created_at: string
          created_by: string | null
          edited_at: string | null
          edited_by: string | null
          edited_by_name: string | null
          fallback: boolean
          fallback_kind: string | null
          fallback_reason: string | null
          id: string
          input_hash: string
          model: string | null
          purpose: string
          rejected: Json
          target: string
          target_id: string
          text: string
          updated_at: string
          usage: Json
          validated: boolean
          workspace_id: string
        }
        Insert: {
          checked?: number
          created_at?: string
          created_by?: string | null
          edited_at?: string | null
          edited_by?: string | null
          edited_by_name?: string | null
          fallback: boolean
          fallback_kind?: string | null
          fallback_reason?: string | null
          id?: string
          input_hash: string
          model?: string | null
          purpose: string
          rejected?: Json
          target: string
          target_id: string
          text: string
          updated_at?: string
          usage?: Json
          validated: boolean
          workspace_id: string
        }
        Update: {
          checked?: number
          created_at?: string
          created_by?: string | null
          edited_at?: string | null
          edited_by?: string | null
          edited_by_name?: string | null
          fallback?: boolean
          fallback_kind?: string | null
          fallback_reason?: string | null
          id?: string
          input_hash?: string
          model?: string | null
          purpose?: string
          rejected?: Json
          target?: string
          target_id?: string
          text?: string
          updated_at?: string
          usage?: Json
          validated?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "narrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          active: boolean
          capacity_hours_week: number | null
          cost_rate: number | null
          created_at: string
          created_by: string | null
          email: string | null
          end_date: string | null
          fte: number
          id: string
          name: string
          notes: string | null
          provenance: Json
          start_date: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          capacity_hours_week?: number | null
          cost_rate?: number | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          end_date?: string | null
          fte?: number
          id?: string
          name: string
          notes?: string | null
          provenance?: Json
          start_date?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          capacity_hours_week?: number | null
          cost_rate?: number | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          end_date?: string | null
          fte?: number
          id?: string
          name?: string
          notes?: string | null
          provenance?: Json
          start_date?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "people_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      person_leave: {
        Row: {
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          note: string | null
          person_id: string
          start_date: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          note?: string | null
          person_id: string
          start_date: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          note?: string | null
          person_id?: string
          start_date?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_leave_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      person_roles: {
        Row: {
          created_at: string
          person_id: string
          role_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          person_id: string
          role_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          person_id?: string
          role_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_roles_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "person_roles_role_id_workspace_id_fkey"
            columns: ["role_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      person_skills: {
        Row: {
          created_at: string
          efficiency: number
          person_id: string
          provenance: Json
          step_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          efficiency?: number
          person_id: string
          provenance?: Json
          step_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          efficiency?: number
          person_id?: string
          provenance?: Json
          step_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_skills_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      process_revisions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          layout: Json
          number: number
          process_id: string
          published_at: string | null
          published_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          layout?: Json
          number: number
          process_id: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          layout?: Json
          number?: number
          process_id?: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "process_revisions_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      processes: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          draft_revision_id: string | null
          entity_name: string
          id: string
          is_company: boolean
          kind: string
          live_revision_id: string | null
          name: string
          parent_process_id: string | null
          source: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          draft_revision_id?: string | null
          entity_name?: string
          id?: string
          is_company?: boolean
          kind?: string
          live_revision_id?: string | null
          name: string
          parent_process_id?: string | null
          source?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          draft_revision_id?: string | null
          entity_name?: string
          id?: string
          is_company?: boolean
          kind?: string
          live_revision_id?: string | null
          name?: string
          parent_process_id?: string | null
          source?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "processes_parent_fk"
            columns: ["parent_process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "processes_draft_revision_id_fkey"
            columns: ["draft_revision_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processes_live_revision_id_fkey"
            columns: ["live_revision_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          content: Json
          content_version: number
          created_at: string
          created_by: string | null
          id: string
          link_expires_at: string | null
          link_hash: string | null
          options: Json
          pdf: string | null
          pdf_generated_at: string | null
          process_id: string | null
          run_id: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          content: Json
          content_version?: number
          created_at?: string
          created_by?: string | null
          id?: string
          link_expires_at?: string | null
          link_hash?: string | null
          options?: Json
          pdf?: string | null
          pdf_generated_at?: string | null
          process_id?: string | null
          run_id?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          content?: Json
          content_version?: number
          created_at?: string
          created_by?: string | null
          id?: string
          link_expires_at?: string | null
          link_hash?: string | null
          options?: Json
          pdf?: string | null
          pdf_generated_at?: string | null
          process_id?: string | null
          run_id?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "reports_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "reports_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      robustness_results: {
        Row: {
          cache_key: string
          check_key: string
          created_at: string
          created_by: string | null
          id: string
          results: Json
          run_id: string | null
          workspace_id: string
        }
        Insert: {
          cache_key: string
          check_key: string
          created_at?: string
          created_by?: string | null
          id?: string
          results: Json
          run_id?: string | null
          workspace_id: string
        }
        Update: {
          cache_key?: string
          check_key?: string
          created_at?: string
          created_by?: string | null
          id?: string
          results?: Json
          run_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "robustness_results_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "robustness_results_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          active: boolean
          color: string | null
          created_at: string
          created_by: string | null
          default_cost_rate: number
          headcount: number
          id: string
          name: string
          ongoing_hours_per_client_week: number
          provenance: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          color?: string | null
          created_at?: string
          created_by?: string | null
          default_cost_rate?: number
          headcount?: number
          id?: string
          name: string
          ongoing_hours_per_client_week?: number
          provenance?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          color?: string | null
          created_at?: string
          created_by?: string | null
          default_cost_rate?: number
          headcount?: number
          id?: string
          name?: string
          ongoing_hours_per_client_week?: number
          provenance?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          created_by: string | null
          duration_ms: number | null
          engine_version: string | null
          id: string
          name: string
          params_snapshot: Json
          process_id: string | null
          reps: number
          results: Json
          revision_ids: string[]
          scenario_id: string | null
          seed: number
          trace_url: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          engine_version?: string | null
          id?: string
          name: string
          params_snapshot: Json
          process_id?: string | null
          reps: number
          results?: Json
          revision_ids?: string[]
          scenario_id?: string | null
          seed: number
          trace_url?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          engine_version?: string | null
          id?: string
          name?: string
          params_snapshot?: Json
          process_id?: string | null
          reps?: number
          results?: Json
          revision_ids?: string[]
          scenario_id?: string | null
          seed?: number
          trace_url?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "runs_scenario_id_workspace_id_fkey"
            columns: ["scenario_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      scenarios: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          parent_scenario_id: string | null
          patch: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          parent_scenario_id?: string | null
          patch?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          parent_scenario_id?: string | null
          patch?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenarios_parent_scenario_id_workspace_id_fkey"
            columns: ["parent_scenario_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "scenarios_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seasonality: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          month: number
          multiplier: number
          provenance: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          month: number
          multiplier?: number
          provenance?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          month?: number
          multiplier?: number
          provenance?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seasonality_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      service_servicing: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          process_id: string
          provenance: Json
          recurrence: Json
          service_id: string
          sla_hours: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          process_id: string
          provenance?: Json
          recurrence?: Json
          service_id: string
          sla_hours?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          process_id?: string
          provenance?: Json
          recurrence?: Json
          service_id?: string
          sla_hours?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_servicing_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "service_servicing_service_id_workspace_id_fkey"
            columns: ["service_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "service_servicing_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          active: boolean
          churn_health_sensitivity: number
          churn_monthly_base: number
          created_at: string
          created_by: string | null
          entry_process_id: string | null
          fallback_ongoing_load: Json
          id: string
          margin: number
          mix_share: number
          name: string
          path_tags: string[]
          price: number
          pricing_model: string
          provenance: Json
          tenure_months: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          churn_health_sensitivity?: number
          churn_monthly_base?: number
          created_at?: string
          created_by?: string | null
          entry_process_id?: string | null
          fallback_ongoing_load?: Json
          id?: string
          margin?: number
          mix_share?: number
          name: string
          path_tags?: string[]
          price?: number
          pricing_model?: string
          provenance?: Json
          tenure_months?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          churn_health_sensitivity?: number
          churn_monthly_base?: number
          created_at?: string
          created_by?: string | null
          entry_process_id?: string | null
          fallback_ongoing_load?: Json
          id?: string
          margin?: number
          mix_share?: number
          name?: string
          path_tags?: string[]
          price?: number
          pricing_model?: string
          provenance?: Json
          tenure_months?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_entry_process_id_workspace_id_fkey"
            columns: ["entry_process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "services_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      solution_issues: {
        Row: {
          auto_note: string
          auto_verdict: string | null
          created_at: string
          created_by: string | null
          holds_pct: number | null
          issue_id: string
          solution_id: string
          updated_at: string
          user_notes: string
          user_verdict: string | null
          workspace_id: string
        }
        Insert: {
          auto_note?: string
          auto_verdict?: string | null
          created_at?: string
          created_by?: string | null
          holds_pct?: number | null
          issue_id: string
          solution_id: string
          updated_at?: string
          user_notes?: string
          user_verdict?: string | null
          workspace_id: string
        }
        Update: {
          auto_note?: string
          auto_verdict?: string | null
          created_at?: string
          created_by?: string | null
          holds_pct?: number | null
          issue_id?: string
          solution_id?: string
          updated_at?: string
          user_notes?: string
          user_verdict?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "solution_issues_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "solution_issues_solution_id_workspace_id_fkey"
            columns: ["solution_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "solutions"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      solutions: {
        Row: {
          base_revision_id: string
          changed_step_ids: Json
          created_at: string
          created_by: string | null
          id: string
          lever_changes: Json
          name: string
          notes: string
          process_id: string
          steps: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          base_revision_id: string
          changed_step_ids?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          lever_changes?: Json
          name: string
          notes?: string
          process_id: string
          steps: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          base_revision_id?: string
          changed_step_ids?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          lever_changes?: Json
          name?: string
          notes?: string
          process_id?: string
          steps?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "solutions_base_revision_id_process_id_workspace_id_fkey"
            columns: ["base_revision_id", "process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "process_id", "workspace_id"]
          },
          {
            foreignKeyName: "solutions_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "solutions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      source_links: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          insight_key: string | null
          issue_id: string | null
          kind: string
          process_id: string | null
          solution_id: string | null
          source_id: string
          step_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          insight_key?: string | null
          issue_id?: string | null
          kind: string
          process_id?: string | null
          solution_id?: string | null
          source_id: string
          step_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          insight_key?: string | null
          issue_id?: string | null
          kind?: string
          process_id?: string | null
          solution_id?: string | null
          source_id?: string
          step_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_links_issue_id_workspace_id_fkey"
            columns: ["issue_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "source_links_process_id_workspace_id_fkey"
            columns: ["process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "source_links_solution_id_workspace_id_fkey"
            columns: ["solution_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "solutions"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "source_links_source_id_workspace_id_fkey"
            columns: ["source_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      sources: {
        Row: {
          body: string | null
          created_at: string
          created_by: string | null
          file_url: string | null
          id: string
          kind: string
          recorded_at: string | null
          speakers: string[]
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          created_by?: string | null
          file_url?: string | null
          id?: string
          kind?: string
          recorded_at?: string | null
          speakers?: string[]
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          created_by?: string | null
          file_url?: string | null
          id?: string
          kind?: string
          recorded_at?: string | null
          speakers?: string[]
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      steps: {
        Row: {
          assumption: boolean
          child_process_id: string | null
          conflict: boolean
          cost_override: number | null
          created_at: string
          created_by: string | null
          current_wip: number | null
          dropoff_benchmark: number | null
          expected_wait_hours: number | null
          entry_step_id: string | null
          id: string
          kind: string
          lost_per_day_waiting: number | null
          name: string
          notes: string | null
          outcome: string | null
          parent_step_id: string | null
          person_id: string | null
          process_id: string
          provenance: Json
          replaced_by: string[]
          revision_id: string
          rework_rate: number
          rework_to_step_id: string | null
          role_id: string | null
          sla_hours: number | null
          target_cycle_hours: number | null
          tool: string | null
          updated_at: string
          wait_dist: string
          wait_hours: number
          wait_params: Json
          work_dist: string
          work_hours: number
          work_params: Json
          workspace_id: string
          x: number
          y: number
        }
        Insert: {
          assumption?: boolean
          child_process_id?: string | null
          conflict?: boolean
          cost_override?: number | null
          created_at?: string
          created_by?: string | null
          current_wip?: number | null
          dropoff_benchmark?: number | null
          expected_wait_hours?: number | null
          entry_step_id?: string | null
          id?: string
          kind?: string
          lost_per_day_waiting?: number | null
          name: string
          notes?: string | null
          outcome?: string | null
          parent_step_id?: string | null
          person_id?: string | null
          process_id: string
          provenance?: Json
          replaced_by?: string[]
          revision_id: string
          rework_rate?: number
          rework_to_step_id?: string | null
          role_id?: string | null
          sla_hours?: number | null
          target_cycle_hours?: number | null
          tool?: string | null
          updated_at?: string
          wait_dist?: string
          wait_hours?: number
          wait_params?: Json
          work_dist?: string
          work_hours?: number
          work_params?: Json
          workspace_id: string
          x?: number
          y?: number
        }
        Update: {
          assumption?: boolean
          child_process_id?: string | null
          conflict?: boolean
          cost_override?: number | null
          created_at?: string
          created_by?: string | null
          current_wip?: number | null
          dropoff_benchmark?: number | null
          expected_wait_hours?: number | null
          entry_step_id?: string | null
          id?: string
          kind?: string
          lost_per_day_waiting?: number | null
          name?: string
          notes?: string | null
          outcome?: string | null
          parent_step_id?: string | null
          person_id?: string | null
          process_id?: string
          provenance?: Json
          replaced_by?: string[]
          revision_id?: string
          rework_rate?: number
          rework_to_step_id?: string | null
          role_id?: string | null
          sla_hours?: number | null
          target_cycle_hours?: number | null
          tool?: string | null
          updated_at?: string
          wait_dist?: string
          wait_hours?: number
          wait_params?: Json
          work_dist?: string
          work_hours?: number
          work_params?: Json
          workspace_id?: string
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "steps_child_process_fk"
            columns: ["child_process_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "processes"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "steps_entry_step_fk"
            columns: ["revision_id", "entry_step_id"]
            isOneToOne: false
            referencedRelation: "steps"
            referencedColumns: ["revision_id", "id"]
          },
          {
            foreignKeyName: "steps_parent_step_fk"
            columns: ["revision_id", "parent_step_id"]
            isOneToOne: false
            referencedRelation: "steps"
            referencedColumns: ["revision_id", "id"]
          },
          {
            foreignKeyName: "steps_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "steps_revision_id_workspace_id_fkey"
            columns: ["revision_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "process_revisions"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "steps_role_id_workspace_id_fkey"
            columns: ["role_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      suggestion_proposals: {
        Row: {
          applied: Json | null
          created_at: string
          created_by: string | null
          created_via: string
          import_source: string | null
          detail: string | null
          evidence: Json
          id: string
          issue_id: string | null
          kind: string
          note: string | null
          payload: Json
          proposer_email: string | null
          proposer_name: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          applied?: Json | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          import_source?: string | null
          detail?: string | null
          evidence?: Json
          id?: string
          issue_id?: string | null
          kind: string
          note?: string | null
          payload?: Json
          proposer_email?: string | null
          proposer_name?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          applied?: Json | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          import_source?: string | null
          detail?: string | null
          evidence?: Json
          id?: string
          issue_id?: string | null
          kind?: string
          note?: string | null
          payload?: Json
          proposer_email?: string | null
          proposer_name?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "suggestion_proposals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      suggestions: {
        Row: {
          applied: Json | null
          created_at: string
          created_by: string | null
          created_via: string
          import_source: string | null
          evidence: Json
          id: string
          note: string | null
          patch: Json
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          target_id: string | null
          target_table: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          applied?: Json | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          import_source?: string | null
          evidence?: Json
          id?: string
          note?: string | null
          patch: Json
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          target_id?: string | null
          target_table: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          applied?: Json | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          import_source?: string | null
          evidence?: Json
          id?: string
          note?: string | null
          patch?: Json
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          target_id?: string | null
          target_table?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "suggestions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_access_emails: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          id: string
          person_id: string | null
          role: Database["public"]["Enums"]["membership_role"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          id?: string
          person_id?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          id?: string
          person_id?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_access_emails_person_id_workspace_id_fkey"
            columns: ["person_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_access_emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_domains: {
        Row: {
          created_at: string
          created_by: string | null
          domain: string
          id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          domain: string
          id?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          domain?: string
          id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_domains_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          plan: string
          provenance: Json
          settings: Json
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          plan?: string
          provenance?: Json
          settings?: Json
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          plan?: string
          provenance?: Json
          settings?: Json
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      process_placements: {
        Row: {
          holder_is_company: boolean | null
          holder_name: string | null
          holder_process_id: string | null
          process_id: string | null
          step_id: string | null
          workspace_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_source: {
        Args: { p_links: Json; p_source: Json; p_workspace: string }
        Returns: string
      }
      build_proposal: {
        Args: {
          p_base_revision: string
          p_changed: Json
          p_levers: Json
          p_links: Json
          p_name: string
          p_process: string
          p_proposal: string
          p_steps: Json
          p_workspace: string
        }
        Returns: Json
      }
      can_edit_workspace: { Args: { ws: string }; Returns: boolean }
      can_manage_workspace: { Args: { ws: string }; Returns: boolean }
      can_read_workspace: { Args: { ws: string }; Returns: boolean }
      create_library_process: {
        Args: {
          p_description?: string
          p_entity_name?: string
          p_kind: string
          p_name: string
          p_source?: string
          p_workspace: string
        }
        Returns: Json
      }
      create_workspace: {
        Args: { ws_name: string; ws_settings?: Json; ws_slug: string }
        Returns: string
      }
      discard_draft: { Args: { target_process: string }; Returns: Json }
      duplicate_version: {
        Args: { new_name: string; source_revision: string }
        Returns: Json
      }
      import_new_process: {
        Args: { p_adopt?: Json; p_nodes: Json; p_workspace: string }
        Returns: Json
      }
      import_process_bundle: {
        Args: { p_adopt?: Json; p_extras?: Json; p_nodes: Json; p_workspace: string }
        Returns: Json
      }
      is_agency_admin: { Args: never; Returns: boolean }
      is_free_mail_domain: { Args: { domain: string }; Returns: boolean }
      log_process_import: {
        Args: { import_source: string; target_process: string }
        Returns: undefined
      }
      open_draft: { Args: { target_process: string }; Returns: Json }
      publish_process: {
        Args: { accept_estimates?: boolean; target_process: string }
        Returns: Json
      }
      qualifies_for_domain: {
        Args: { domain: string; uid: string }
        Returns: boolean
      }
      reconcile_access: { Args: { uid: string }; Returns: undefined }
      report_download: {
        Args: { token: string }
        Returns: {
          content: Json
          expires_at: string
          id: string
          pdf: string | null
          title: string
          workspace_id: string
        }[]
      }
      resolve_my_access: {
        Args: never
        Returns: {
          role: Database["public"]["Enums"]["membership_role"]
          source: string
          workspace_id: string
        }[]
      }
      reserve_ai_run: {
        Args: { p_process: string; p_trigger: string; p_workspace: string }
        Returns: Json
      }
      restore_version: {
        Args: {
          replace_draft?: boolean
          source_revision: string
          target_process: string
        }
        Returns: Json
      }
      review_proposals: {
        Args: { decision: string; ids: string[]; note?: string }
        Returns: Json
      }
      review_suggestions: {
        Args: { decision: string; ids: string[]; note?: string }
        Returns: Json
      }
      revision_history: {
        Args: { target_process: string }
        Returns: {
          author_kind: string | null
          author_name: string | null
          changes: Json | null
          note: string | null
          number: number
          published_at: string | null
          revision_id: string
          status: string
        }[]
      }
      resolve_issue:
        | {
            Args: {
              p_how: string
              p_id: string
              p_note?: string
              p_status?: string
              p_workspace: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_how: string
              p_id: string
              p_note: string
              p_solution: string
              p_status: string
              p_workspace: string
            }
            Returns: Json
          }
      save_fields: {
        Args: { base: Json; changes: Json; key: Json; target: string }
        Returns: Json
      }
      save_issue: {
        Args: {
          p_fields: Json
          p_id?: string
          p_links?: Json
          p_owners?: string[]
          p_sources?: string[]
          p_workspace: string
        }
        Returns: Json
      }
      save_links: {
        Args: {
          base: Json
          member: string
          next: Json
          owner: Json
          target: string
        }
        Returns: Json
      }
      save_solution: {
        Args: {
          p_base_revision: string
          p_changed?: Json
          p_levers?: Json
          p_links?: Json
          p_name: string
          p_process: string
          p_steps: Json
          p_workspace: string
        }
        Returns: Json
      }
      take_link_fetch: { Args: never; Returns: number }
      unlinked_source_count: {
        Args: { p_workspace: string }
        Returns: number
      }
      workspace_members: {
        Args: { ws: string }
        Returns: {
          active: boolean
          created_at: string
          email: string
          last_sign_in_at: string
          membership_id: string
          person_id: string
          role: Database["public"]["Enums"]["membership_role"]
          source: string
          user_id: string
        }[]
      }
      workspace_role: {
        Args: { ws: string }
        Returns: Database["public"]["Enums"]["membership_role"]
      }
      use_api_token: { Args: { token: string }; Returns: Json }
    }
    Enums: {
      membership_role: "agency_admin" | "owner" | "editor" | "member" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      membership_role: ["agency_admin", "owner", "editor", "member", "viewer"],
    },
  },
} as const
