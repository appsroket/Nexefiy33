// Generated from the Supabase schema. Do not edit by hand.
// Regenerate after every migration: npm run db:types (or the Supabase MCP generate_typescript_types tool).

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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_employees: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          active_version_id: string | null
          avatar_url: string | null
          created_at: string
          created_by: string | null
          current_version_id: string | null
          description: string | null
          id: string
          lifecycle_status: string
          name: string
          organization_id: string
          role_category: string
          status: string
          template_key: string | null
          testing_started_at: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          active_version_id?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          role_category: string
          status?: string
          template_key?: string | null
          testing_started_at?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          active_version_id?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          role_category?: string
          status?: string
          template_key?: string | null
          testing_started_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_employees_active_version_fk"
            columns: ["active_version_id", "id"]
            isOneToOne: false
            referencedRelation: "employee_versions"
            referencedColumns: ["id", "employee_id"]
          },
          {
            foreignKeyName: "ai_employees_current_version_fk"
            columns: ["current_version_id", "id"]
            isOneToOne: false
            referencedRelation: "employee_versions"
            referencedColumns: ["id", "employee_id"]
          },
          {
            foreignKeyName: "ai_employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_requests: {
        Row: {
          action_summary: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          employee_id: string | null
          employee_version_id: string | null
          expires_at: string
          id: string
          organization_id: string
          payload_sha256: string
          policy_id: string | null
          policy_revision: number | null
          proposed_action: Json
          required_role: string
          status: string
          task_id: string
          tool_execution_id: string
          updated_at: string
          workflow_run_id: string | null
          workflow_version_id: string | null
        }
        Insert: {
          action_summary: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          employee_id?: string | null
          employee_version_id?: string | null
          expires_at: string
          id?: string
          organization_id: string
          payload_sha256: string
          policy_id?: string | null
          policy_revision?: number | null
          proposed_action: Json
          required_role?: string
          status?: string
          task_id: string
          tool_execution_id: string
          updated_at?: string
          workflow_run_id?: string | null
          workflow_version_id?: string | null
        }
        Update: {
          action_summary?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          employee_id?: string | null
          employee_version_id?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          payload_sha256?: string
          policy_id?: string | null
          policy_revision?: number | null
          proposed_action?: Json
          required_role?: string
          status?: string
          task_id?: string
          tool_execution_id?: string
          updated_at?: string
          workflow_run_id?: string | null
          workflow_version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_employee_version_id_organization_id_fkey"
            columns: ["employee_version_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "employee_versions"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_policy_id_organization_id_fkey"
            columns: ["policy_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_policies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_tool_execution_id_organization_id_fkey"
            columns: ["tool_execution_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tool_executions"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_workflow_run_id_organization_id_fkey"
            columns: ["workflow_run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "approval_requests_workflow_version_id_organization_id_fkey"
            columns: ["workflow_version_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_versions"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_employee_id: string | null
          actor_type: string
          actor_user_id: string | null
          id: number
          metadata: Json
          occurred_at: string
          organization_id: string | null
          target_id: string | null
          target_table: string | null
        }
        Insert: {
          action: string
          actor_employee_id?: string | null
          actor_type: string
          actor_user_id?: string | null
          id?: never
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          target_id?: string | null
          target_table?: string | null
        }
        Update: {
          action?: string
          actor_employee_id?: string | null
          actor_type?: string
          actor_user_id?: string | null
          id?: never
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          target_id?: string | null
          target_table?: string | null
        }
        Relationships: []
      }
      business_context_items: {
        Row: {
          attributes: Json
          body: string
          created_at: string
          created_by: string | null
          id: string
          kind: string
          organization_id: string
          position: number
          status: string
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          attributes?: Json
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          organization_id: string
          position?: number
          status?: string
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          attributes?: Json
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          organization_id?: string
          position?: number
          status?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_context_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      company_settings: {
        Row: {
          brand_voice: string | null
          created_at: string
          default_currency: string
          description: string | null
          industry: string | null
          legal_name: string | null
          locale: string
          organization_id: string
          settings: Json
          timezone: string
          updated_at: string
          updated_by: string | null
          website: string | null
        }
        Insert: {
          brand_voice?: string | null
          created_at?: string
          default_currency?: string
          description?: string | null
          industry?: string | null
          legal_name?: string | null
          locale?: string
          organization_id: string
          settings?: Json
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          website?: string | null
        }
        Update: {
          brand_voice?: string | null
          created_at?: string
          default_currency?: string
          description?: string | null
          industry?: string | null
          legal_name?: string | null
          locale?: string
          organization_id?: string
          settings?: Json
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "company_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_skills: {
        Row: {
          config: Json
          created_at: string
          employee_id: string
          enabled: boolean
          organization_id: string
          skill_id: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          employee_id: string
          enabled?: boolean
          organization_id: string
          skill_id: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          employee_id?: string
          enabled?: boolean
          organization_id?: string
          skill_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_skills_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "employee_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_test_cases: {
        Row: {
          created_at: string
          created_by: string | null
          employee_id: string
          expectations: Json
          id: string
          input: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          employee_id: string
          expectations?: Json
          id?: string
          input: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          employee_id?: string
          expectations?: Json
          id?: string
          input?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_test_cases_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      employee_test_runs: {
        Row: {
          checks: Json
          cost_micros: number
          created_at: string
          created_by: string | null
          employee_id: string
          error: Json | null
          finished_at: string | null
          id: string
          input: string
          input_tokens: number
          model: string | null
          organization_id: string
          outcome: string | null
          output_tokens: number
          reply: string | null
          result: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          started_at: string
          test_case_id: string | null
          transcript: Json
          version_id: string
        }
        Insert: {
          checks?: Json
          cost_micros?: number
          created_at?: string
          created_by?: string | null
          employee_id: string
          error?: Json | null
          finished_at?: string | null
          id?: string
          input: string
          input_tokens?: number
          model?: string | null
          organization_id: string
          outcome?: string | null
          output_tokens?: number
          reply?: string | null
          result?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          started_at?: string
          test_case_id?: string | null
          transcript?: Json
          version_id: string
        }
        Update: {
          checks?: Json
          cost_micros?: number
          created_at?: string
          created_by?: string | null
          employee_id?: string
          error?: Json | null
          finished_at?: string | null
          id?: string
          input?: string
          input_tokens?: number
          model?: string | null
          organization_id?: string
          outcome?: string | null
          output_tokens?: number
          reply?: string | null
          result?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          started_at?: string
          test_case_id?: string | null
          transcript?: Json
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_test_runs_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "employee_test_runs_test_case_id_employee_id_fkey"
            columns: ["test_case_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employee_test_cases"
            referencedColumns: ["id", "employee_id"]
          },
          {
            foreignKeyName: "employee_test_runs_version_id_employee_id_fkey"
            columns: ["version_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employee_versions"
            referencedColumns: ["id", "employee_id"]
          },
        ]
      }
      employee_tool_permissions: {
        Row: {
          constraints: Json
          created_at: string
          decision: string
          employee_id: string
          granted_by: string | null
          id: string
          integration_id: string | null
          organization_id: string
          tool_key: string
          updated_at: string
        }
        Insert: {
          constraints?: Json
          created_at?: string
          decision?: string
          employee_id: string
          granted_by?: string | null
          id?: string
          integration_id?: string | null
          organization_id: string
          tool_key: string
          updated_at?: string
        }
        Update: {
          constraints?: Json
          created_at?: string
          decision?: string
          employee_id?: string
          granted_by?: string | null
          id?: string
          integration_id?: string | null
          organization_id?: string
          tool_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_tool_permissions_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "employee_tool_permissions_integration_fk"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      employee_versions: {
        Row: {
          change_note: string | null
          config: Json
          config_schema_version: number
          created_at: string
          created_by: string | null
          employee_id: string
          id: string
          instructions: string
          organization_id: string
          version: number
        }
        Insert: {
          change_note?: string | null
          config: Json
          config_schema_version?: number
          created_at?: string
          created_by?: string | null
          employee_id: string
          id?: string
          instructions: string
          organization_id: string
          version: number
        }
        Update: {
          change_note?: string | null
          config?: Json
          config_schema_version?: number
          created_at?: string
          created_by?: string | null
          employee_id?: string
          id?: string
          instructions?: string
          organization_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_versions_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      execution_events: {
        Row: {
          created_at: string
          data: Json
          event_type: string
          id: number
          level: string
          message: string | null
          organization_id: string
          task_id: string | null
          tool_execution_id: string | null
          workflow_run_id: string | null
        }
        Insert: {
          created_at?: string
          data?: Json
          event_type: string
          id?: never
          level?: string
          message?: string | null
          organization_id: string
          task_id?: string | null
          tool_execution_id?: string | null
          workflow_run_id?: string | null
        }
        Update: {
          created_at?: string
          data?: Json
          event_type?: string
          id?: never
          level?: string
          message?: string | null
          organization_id?: string
          task_id?: string | null
          tool_execution_id?: string | null
          workflow_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "execution_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_events_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "execution_events_tool_execution_id_organization_id_fkey"
            columns: ["tool_execution_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tool_executions"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "execution_events_workflow_run_id_organization_id_fkey"
            columns: ["workflow_run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      integration_actions: {
        Row: {
          action_key: string
          approval_mode: string
          config: Json
          created_at: string
          enabled: boolean
          id: string
          integration_id: string
          organization_id: string
          risk_level: string
          updated_at: string
        }
        Insert: {
          action_key: string
          approval_mode?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          integration_id: string
          organization_id: string
          risk_level: string
          updated_at?: string
        }
        Update: {
          action_key?: string
          approval_mode?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          integration_id?: string
          organization_id?: string
          risk_level?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_actions_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      integration_oauth_states: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          integration_id: string | null
          organization_id: string
          provider: string
          return_path: string
          state_sha256: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          integration_id?: string | null
          organization_id: string
          provider: string
          return_path?: string
          state_sha256: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          integration_id?: string | null
          organization_id?: string
          provider?: string
          return_path?: string
          state_sha256?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_oauth_states_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "integration_oauth_states_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_rate_limit_windows: {
        Row: {
          bucket: string
          integration_id: string
          organization_id: string
          request_count: number
          window_start: string
        }
        Insert: {
          bucket: string
          integration_id: string
          organization_id: string
          request_count?: number
          window_start: string
        }
        Update: {
          bucket?: string
          integration_id?: string
          organization_id?: string
          request_count?: number
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_rate_limit_windows_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      integration_secrets: {
        Row: {
          access_token_expires_at: string | null
          ciphertext: string
          created_at: string
          integration_id: string
          key_id: string
          organization_id: string
          refresh_lease_until: string | null
          rotated_at: string | null
          secret_kind: string
          updated_at: string
        }
        Insert: {
          access_token_expires_at?: string | null
          ciphertext: string
          created_at?: string
          integration_id: string
          key_id: string
          organization_id: string
          refresh_lease_until?: string | null
          rotated_at?: string | null
          secret_kind: string
          updated_at?: string
        }
        Update: {
          access_token_expires_at?: string | null
          ciphertext?: string
          created_at?: string
          integration_id?: string
          key_id?: string
          organization_id?: string
          refresh_lease_until?: string | null
          rotated_at?: string | null
          secret_kind?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      integrations: {
        Row: {
          connected_at: string | null
          connected_by: string | null
          created_at: string
          display_name: string
          external_account_id: string | null
          external_account_label: string | null
          granted_scopes: string[]
          health_message: string | null
          health_status: string
          id: string
          last_error: string | null
          last_health_check_at: string | null
          organization_id: string
          provider: string
          provider_metadata: Json
          revoked_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          display_name: string
          external_account_id?: string | null
          external_account_label?: string | null
          granted_scopes?: string[]
          health_message?: string | null
          health_status?: string
          id?: string
          last_error?: string | null
          last_health_check_at?: string | null
          organization_id: string
          provider: string
          provider_metadata?: Json
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          display_name?: string
          external_account_id?: string | null
          external_account_label?: string | null
          granted_scopes?: string[]
          health_message?: string | null
          health_status?: string
          id?: string
          last_error?: string | null
          last_health_check_at?: string | null
          organization_id?: string
          provider?: string
          provider_metadata?: Json
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          chunk_index: number
          content: string
          content_sha256: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          id: string
          metadata: Json
          organization_id: string
          search_vector: unknown
          source_id: string
          token_count: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          content_sha256: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          id?: string
          metadata?: Json
          organization_id: string
          search_vector?: never
          source_id: string
          token_count?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          content_sha256?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          id?: string
          metadata?: Json
          organization_id?: string
          search_vector?: never
          source_id?: string
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_source_id_organization_id_fkey"
            columns: ["source_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "knowledge_sources"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      knowledge_sources: {
        Row: {
          byte_size: number | null
          chunk_count: number
          content_sha256: string | null
          context_item_id: string | null
          created_at: string
          created_by: string | null
          embedding_model: string | null
          error_message: string | null
          id: string
          integration_id: string | null
          last_indexed_at: string | null
          metadata: Json
          mime_type: string | null
          name: string
          next_attempt_at: string | null
          organization_id: string
          processing_attempts: number
          processing_started_at: string | null
          source_type: string
          source_url: string | null
          status: string
          storage_bucket: string | null
          storage_path: string | null
          updated_at: string
        }
        Insert: {
          byte_size?: number | null
          chunk_count?: number
          content_sha256?: string | null
          context_item_id?: string | null
          created_at?: string
          created_by?: string | null
          embedding_model?: string | null
          error_message?: string | null
          id?: string
          integration_id?: string | null
          last_indexed_at?: string | null
          metadata?: Json
          mime_type?: string | null
          name: string
          next_attempt_at?: string | null
          organization_id: string
          processing_attempts?: number
          processing_started_at?: string | null
          source_type: string
          source_url?: string | null
          status?: string
          storage_bucket?: string | null
          storage_path?: string | null
          updated_at?: string
        }
        Update: {
          byte_size?: number | null
          chunk_count?: number
          content_sha256?: string | null
          context_item_id?: string | null
          created_at?: string
          created_by?: string | null
          embedding_model?: string | null
          error_message?: string | null
          id?: string
          integration_id?: string | null
          last_indexed_at?: string | null
          metadata?: Json
          mime_type?: string | null
          name?: string
          next_attempt_at?: string | null
          organization_id?: string
          processing_attempts?: number
          processing_started_at?: string | null
          source_type?: string
          source_url?: string | null
          status?: string
          storage_bucket?: string | null
          storage_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_sources_context_item_fk"
            columns: ["context_item_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "business_context_items"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "knowledge_sources_integration_fk"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "knowledge_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string
          role: string
          status: string
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id: string
          role: string
          status?: string
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string
          role?: string
          status?: string
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          invited_by: string | null
          organization_id: string
          revoked_at: string | null
          revoked_by: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          organization_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          organization_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_policies: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          enabled: boolean
          id: string
          name: string
          organization_id: string
          policy: Json
          policy_schema_version: number
          priority: number
          revision: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          organization_id: string
          policy: Json
          policy_schema_version?: number
          priority?: number
          revision?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          organization_id?: string
          policy?: Json
          policy_schema_version?: number
          priority?: number
          revision?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      outcome_records: {
        Row: {
          created_at: string
          currency: string | null
          employee_id: string | null
          id: string
          idempotency_key: string | null
          metadata: Json
          occurred_at: string
          organization_id: string
          outcome_key: string
          quantity: number
          task_id: string | null
          unit: string | null
          value_minor: number | null
          workflow_run_id: string | null
        }
        Insert: {
          created_at?: string
          currency?: string | null
          employee_id?: string | null
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id: string
          outcome_key: string
          quantity?: number
          task_id?: string | null
          unit?: string | null
          value_minor?: number | null
          workflow_run_id?: string | null
        }
        Update: {
          created_at?: string
          currency?: string | null
          employee_id?: string | null
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id?: string
          outcome_key?: string
          quantity?: number
          task_id?: string | null
          unit?: string | null
          value_minor?: number | null
          workflow_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outcome_records_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "outcome_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_records_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "outcome_records_workflow_run_id_organization_id_fkey"
            columns: ["workflow_run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      plan_entitlements: {
        Row: {
          created_at: string
          entitlement_key: string
          is_enabled: boolean
          limit_value: number | null
          plan_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          entitlement_key: string
          is_enabled?: boolean
          limit_value?: number | null
          plan_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          entitlement_key?: string
          is_enabled?: boolean
          limit_value?: number | null
          plan_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_entitlements_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["plan_key"]
          },
        ]
      }
      plans: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          is_active: boolean
          is_public: boolean
          monthly_price_minor: number | null
          name: string
          plan_key: string
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          is_active?: boolean
          is_public?: boolean
          monthly_price_minor?: number | null
          name: string
          plan_key: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          is_active?: boolean
          is_public?: boolean
          monthly_price_minor?: number | null
          name?: string
          plan_key?: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_webhook_events: {
        Row: {
          attempts: number
          event_id: string
          event_type: string
          id: string
          last_error: string | null
          organization_id: string | null
          payload_sha256: string
          processed_at: string | null
          provider: string
          received_at: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          event_id: string
          event_type: string
          id?: string
          last_error?: string | null
          organization_id?: string | null
          payload_sha256: string
          processed_at?: string | null
          provider: string
          received_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          event_id?: string
          event_type?: string
          id?: string
          last_error?: string | null
          organization_id?: string | null
          payload_sha256?: string
          processed_at?: string | null
          provider?: string
          received_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      skills: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          instructions: string | null
          key: string
          name: string
          organization_id: string | null
          status: string
          tool_keys: string[]
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions?: string | null
          key: string
          name: string
          organization_id?: string | null
          status?: string
          tool_keys?: string[]
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions?: string | null
          key?: string
          name?: string
          organization_id?: string | null
          status?: string
          tool_keys?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skills_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          currency: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          organization_id: string
          plan_key: string
          provider: string
          provider_customer_id: string | null
          provider_subscription_id: string | null
          quantity: number
          status: string
          trial_ends_at: string | null
          unit_amount_minor: number | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          currency: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          organization_id: string
          plan_key: string
          provider?: string
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          quantity?: number
          status: string
          trial_ends_at?: string | null
          unit_amount_minor?: number | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          organization_id?: string
          plan_key?: string
          provider?: string
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          quantity?: number
          status?: string
          trial_ends_at?: string | null
          unit_amount_minor?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["plan_key"]
          },
        ]
      }
      task_attempts: {
        Row: {
          attempt_number: number
          created_at: string
          engine_attempt_id: string | null
          error: Json | null
          finished_at: string | null
          id: string
          model_input_tokens: number
          model_output_tokens: number
          organization_id: string
          started_at: string
          status: string
          task_id: string
        }
        Insert: {
          attempt_number: number
          created_at?: string
          engine_attempt_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          model_input_tokens?: number
          model_output_tokens?: number
          organization_id: string
          started_at?: string
          status?: string
          task_id: string
        }
        Update: {
          attempt_number?: number
          created_at?: string
          engine_attempt_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          model_input_tokens?: number
          model_output_tokens?: number
          organization_id?: string
          started_at?: string
          status?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_attempts_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          dependency_type: string
          depends_on_task_id: string
          organization_id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          dependency_type?: string
          depends_on_task_id: string
          organization_id: string
          task_id: string
        }
        Update: {
          created_at?: string
          dependency_type?: string
          depends_on_task_id?: string
          organization_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_organization_id_fkey"
            columns: ["depends_on_task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "task_dependencies_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      tasks: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          employee_id: string | null
          employee_version_id: string | null
          error: Json | null
          id: string
          idempotency_key: string
          input: Json
          instructions: string | null
          max_attempts: number
          node_id: string | null
          organization_id: string
          priority: number
          result: Json | null
          result_ref: string | null
          scheduled_at: string | null
          source: string
          started_at: string | null
          status: string
          title: string
          updated_at: string
          workflow_run_id: string | null
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          employee_id?: string | null
          employee_version_id?: string | null
          error?: Json | null
          id?: string
          idempotency_key: string
          input?: Json
          instructions?: string | null
          max_attempts?: number
          node_id?: string | null
          organization_id: string
          priority?: number
          result?: Json | null
          result_ref?: string | null
          scheduled_at?: string | null
          source: string
          started_at?: string | null
          status?: string
          title: string
          updated_at?: string
          workflow_run_id?: string | null
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          employee_id?: string | null
          employee_version_id?: string | null
          error?: Json | null
          id?: string
          idempotency_key?: string
          input?: Json
          instructions?: string | null
          max_attempts?: number
          node_id?: string | null
          organization_id?: string
          priority?: number
          result?: Json | null
          result_ref?: string | null
          scheduled_at?: string | null
          source?: string
          started_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          workflow_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "tasks_employee_version_id_employee_id_fkey"
            columns: ["employee_version_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employee_versions"
            referencedColumns: ["id", "employee_id"]
          },
          {
            foreignKeyName: "tasks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_workflow_run_id_organization_id_fkey"
            columns: ["workflow_run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      tool_executions: {
        Row: {
          attempt_count: number
          created_at: string
          employee_id: string | null
          error: Json | null
          finished_at: string | null
          id: string
          idempotency_key: string
          input_redacted: Json
          input_sha256: string
          integration_id: string | null
          lease_expires_at: string | null
          organization_id: string
          output_redacted: Json | null
          output_ref: string | null
          pending_input: Json | null
          policy_decision: string
          policy_id: string | null
          policy_reason: string | null
          requested_by: string | null
          risk_level: string
          started_at: string | null
          status: string
          task_attempt_id: string | null
          task_id: string
          tool_key: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          employee_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          idempotency_key: string
          input_redacted?: Json
          input_sha256: string
          integration_id?: string | null
          lease_expires_at?: string | null
          organization_id: string
          output_redacted?: Json | null
          output_ref?: string | null
          pending_input?: Json | null
          policy_decision: string
          policy_id?: string | null
          policy_reason?: string | null
          requested_by?: string | null
          risk_level: string
          started_at?: string | null
          status?: string
          task_attempt_id?: string | null
          task_id: string
          tool_key: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          employee_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          input_redacted?: Json
          input_sha256?: string
          integration_id?: string | null
          lease_expires_at?: string | null
          organization_id?: string
          output_redacted?: Json | null
          output_ref?: string | null
          pending_input?: Json | null
          policy_decision?: string
          policy_id?: string | null
          policy_reason?: string | null
          requested_by?: string | null
          risk_level?: string
          started_at?: string | null
          status?: string
          task_attempt_id?: string | null
          task_id?: string
          tool_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_executions_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "tool_executions_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "tool_executions_policy_fk"
            columns: ["policy_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_policies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "tool_executions_task_attempt_id_task_id_fkey"
            columns: ["task_attempt_id", "task_id"]
            isOneToOne: false
            referencedRelation: "task_attempts"
            referencedColumns: ["id", "task_id"]
          },
          {
            foreignKeyName: "tool_executions_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      usage_records: {
        Row: {
          cost_micros: number | null
          created_at: string
          currency: string | null
          employee_id: string | null
          id: number
          idempotency_key: string
          metric: string
          model: string | null
          occurred_at: string
          organization_id: string
          provider: string | null
          quantity: number
          task_id: string | null
          workflow_run_id: string | null
        }
        Insert: {
          cost_micros?: number | null
          created_at?: string
          currency?: string | null
          employee_id?: string | null
          id?: never
          idempotency_key: string
          metric: string
          model?: string | null
          occurred_at?: string
          organization_id: string
          provider?: string | null
          quantity: number
          task_id?: string | null
          workflow_run_id?: string | null
        }
        Update: {
          cost_micros?: number | null
          created_at?: string
          currency?: string | null
          employee_id?: string | null
          id?: never
          idempotency_key?: string
          metric?: string
          model?: string | null
          occurred_at?: string
          organization_id?: string
          provider?: string | null
          quantity?: number
          task_id?: string | null
          workflow_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_records_employee_id_organization_id_fkey"
            columns: ["employee_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "usage_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_records_task_id_organization_id_fkey"
            columns: ["task_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "usage_records_workflow_run_id_organization_id_fkey"
            columns: ["workflow_run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      workflow_definitions: {
        Row: {
          created_at: string
          created_by: string | null
          current_version_id: string | null
          description: string | null
          draft_graph: Json
          draft_schema_version: number
          id: string
          lock_version: number
          name: string
          organization_id: string
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          draft_graph?: Json
          draft_schema_version?: number
          id?: string
          lock_version?: number
          name: string
          organization_id: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          draft_graph?: Json
          draft_schema_version?: number
          id?: string
          lock_version?: number
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workflow_definitions_current_version_fk"
            columns: ["current_version_id", "id"]
            isOneToOne: false
            referencedRelation: "workflow_versions"
            referencedColumns: ["id", "workflow_id"]
          },
          {
            foreignKeyName: "workflow_definitions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_runs: {
        Row: {
          cancel_requested_at: string | null
          created_at: string
          created_by: string | null
          engine_run_id: string | null
          error: Json | null
          finished_at: string | null
          id: string
          idempotency_key: string
          input: Json
          organization_id: string
          output_ref: string | null
          queued_at: string
          started_at: string | null
          status: string
          trigger_id: string | null
          trigger_type: string
          updated_at: string
          workflow_id: string
          workflow_version_id: string
        }
        Insert: {
          cancel_requested_at?: string | null
          created_at?: string
          created_by?: string | null
          engine_run_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          idempotency_key: string
          input?: Json
          organization_id: string
          output_ref?: string | null
          queued_at?: string
          started_at?: string | null
          status?: string
          trigger_id?: string | null
          trigger_type: string
          updated_at?: string
          workflow_id: string
          workflow_version_id: string
        }
        Update: {
          cancel_requested_at?: string | null
          created_at?: string
          created_by?: string | null
          engine_run_id?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          input?: Json
          organization_id?: string
          output_ref?: string | null
          queued_at?: string
          started_at?: string | null
          status?: string
          trigger_id?: string | null
          trigger_type?: string
          updated_at?: string
          workflow_id?: string
          workflow_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_trigger_id_organization_id_fkey"
            columns: ["trigger_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_triggers"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "workflow_runs_workflow_id_organization_id_fkey"
            columns: ["workflow_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_definitions"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "workflow_runs_workflow_version_id_workflow_id_fkey"
            columns: ["workflow_version_id", "workflow_id"]
            isOneToOne: false
            referencedRelation: "workflow_versions"
            referencedColumns: ["id", "workflow_id"]
          },
        ]
      }
      workflow_triggers: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          cron_expression: string | null
          enabled: boolean
          event_type: string | null
          id: string
          integration_id: string | null
          last_fired_at: string | null
          next_run_at: string | null
          organization_id: string
          timezone: string | null
          trigger_type: string
          updated_at: string
          webhook_secret_hash: string | null
          workflow_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          enabled?: boolean
          event_type?: string | null
          id?: string
          integration_id?: string | null
          last_fired_at?: string | null
          next_run_at?: string | null
          organization_id: string
          timezone?: string | null
          trigger_type: string
          updated_at?: string
          webhook_secret_hash?: string | null
          workflow_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          enabled?: boolean
          event_type?: string | null
          id?: string
          integration_id?: string | null
          last_fired_at?: string | null
          next_run_at?: string | null
          organization_id?: string
          timezone?: string | null
          trigger_type?: string
          updated_at?: string
          webhook_secret_hash?: string | null
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_triggers_integration_id_organization_id_fkey"
            columns: ["integration_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "workflow_triggers_workflow_id_organization_id_fkey"
            columns: ["workflow_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_definitions"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      workflow_versions: {
        Row: {
          created_at: string
          generation_metadata: Json | null
          graph: Json
          graph_schema_version: number
          graph_sha256: string
          id: string
          organization_id: string
          published_by: string | null
          source: string
          validation_report: Json
          version: number
          workflow_id: string
        }
        Insert: {
          created_at?: string
          generation_metadata?: Json | null
          graph: Json
          graph_schema_version?: number
          graph_sha256: string
          id?: string
          organization_id: string
          published_by?: string | null
          source?: string
          validation_report?: Json
          version: number
          workflow_id: string
        }
        Update: {
          created_at?: string
          generation_metadata?: Json | null
          graph?: Json
          graph_schema_version?: number
          graph_sha256?: string
          id?: string
          organization_id?: string
          published_by?: string | null
          source?: string
          validation_report?: Json
          version?: number
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_versions_workflow_id_organization_id_fkey"
            columns: ["workflow_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "workflow_definitions"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: { Args: { p_token: string }; Returns: string }
      change_employee_status: {
        Args: {
          p_action: string
          p_confirm_name?: string
          p_employee_id: string
          p_version_id?: string
        }
        Returns: Json
      }
      claim_knowledge_sources: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_max_attempts?: number
          p_organization_id?: string
        }
        Returns: {
          attempt: number
          organization_id: string
          source_id: string
        }[]
      }
      claim_tool_executions: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempt: number
          organization_id: string
          recovered: boolean
          tool_execution_id: string
        }[]
      }
      consume_integration_rate_limit: {
        Args: {
          p_bucket: string
          p_integration_id: string
          p_limit: number
          p_organization_id: string
          p_window_seconds: number
        }
        Returns: {
          allowed: boolean
          retry_after_ms: number
        }[]
      }
      create_employee: {
        Args: {
          p_change_note?: string
          p_config: Json
          p_instructions: string
          p_organization_id: string
        }
        Returns: string
      }
      create_invitation: {
        Args: {
          p_email: string
          p_expires_in?: string
          p_organization_id: string
          p_role: string
        }
        Returns: {
          expires_at: string
          invitation_id: string
          token: string
        }[]
      }
      create_organization: {
        Args: { p_name: string; p_slug: string }
        Returns: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decide_approval: {
        Args: {
          p_decision: string
          p_note?: string
          p_payload_sha256: string
          p_request_id: string
        }
        Returns: {
          action_summary: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          employee_id: string | null
          employee_version_id: string | null
          expires_at: string
          id: string
          organization_id: string
          payload_sha256: string
          policy_id: string | null
          policy_revision: number | null
          proposed_action: Json
          required_role: string
          status: string
          task_id: string
          tool_execution_id: string
          updated_at: string
          workflow_run_id: string | null
          workflow_version_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "approval_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      employee_test_summary: {
        Args: { p_employee_id: string }
        Returns: {
          failed_runs: number
          last_run_at: string | null
          passed_runs: number
          test_status: string
          version_id: string
        }[]
      }
      get_invitation: {
        Args: { p_token: string }
        Returns: {
          already_member: boolean
          email_matches: boolean
          expires_at: string
          invited_email: string
          organization_id: string
          organization_name: string
          role: string
          status: string
        }[]
      }
      match_knowledge_chunks: {
        Args: {
          p_match_count?: number
          p_min_similarity?: number
          p_organization_id: string
          p_query_embedding: string
          p_source_ids?: string[]
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          content: string
          metadata: Json
          similarity: number
          source_id: string
          source_name: string
        }[]
      }
      reprocess_knowledge_source: {
        Args: { p_source_id: string }
        Returns: string
      }
      review_employee_test_run: {
        Args: { p_note?: string; p_run_id: string; p_verdict: string }
        Returns: string
      }
      save_employee_version: {
        Args: {
          p_based_on_version_id: string
          p_change_note?: string
          p_config: Json
          p_employee_id: string
          p_instructions: string
        }
        Returns: Json
      }
      search_knowledge: {
        Args: {
          p_match_count?: number
          p_organization_id: string
          p_query: string
          p_query_embedding?: string
          p_source_ids?: string[]
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          content: string
          keyword_rank: number
          metadata: Json
          score: number
          similarity: number
          source_id: string
          source_name: string
          source_type: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
